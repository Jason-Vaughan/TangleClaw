# The merge queue

*Being built (#2322). A queue can be made, submitted to, read and withdrawn from, and the Operator
gate can be recorded. **Nothing lands yet:** no route assembles a candidate or merges a pull
request, and there is no screen. This page grows with each part as it lands.*

## Using the queue

A queue belongs to one repository and base branch and has one owner project. An entry is one pull
request at one exact head commit.

| Who | May |
|---|---|
| The Operator | make a queue and name its owner; record an entry's Operator gate; read |
| A verified live launch of the owner project | submit an entry; withdraw an entry; read |
| A project that shares a group with the owner | read |
| Anyone else | nothing. A queue they may not read does not exist for them (`404`) |

"Verified live launch" means the request carries `x-tangleclaw-project-id` and
`x-tangleclaw-launch-id` of that project's active session; `tc` sends them. The Operator is not the
owner and cannot submit or withdraw. The owner cannot record the Operator gate: a session saying
the Operator agreed is not the Operator.

### Making the queue (the Operator, once)

There is no screen and no first-caller ownership. On the signed-in dashboard, open the browser's
console and run, with the owner project's numeric id (`tc whoami` in that project's pane prints it):

```js
tcFetch('/api/merge-queue', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ repo: 'Jason-Vaughan/TangleClaw', baseBranch: 'main', ownerProjectId: 12 /* the owner project's id */ })
}).then((r) => r.json()).then(console.log);
```

`tcFetch` is the dashboard's own request function and sends the signed-in session's CSRF token. A
bare `fetch` does not, and a signed-in install refuses it (`403 CSRF_TOKEN_INVALID`).

The answer is the queue with its id. The Operator's proof tier is recorded with it, as for a control
command ([control-state.md](control-state.md), "Operator proof tier"): a signed-in session, or an
install whose auth gate is deliberately open. A second active queue for the same repository and
base is refused (`QUEUE_EXISTS`).

### The routes

```
POST /api/merge-queue                              {repo, baseBranch, ownerProjectId}     Operator only
GET  /api/merge-queue                              every active queue the caller may read, entries in order
GET  /api/merge-queue/entries/:id                  one entry, its queue and its history
POST /api/merge-queue/entries                      {prNumber, headSha, gates: {review, test, base},
                                                    operatorGate: "required"|"none", queueId?}   the owner
POST /api/merge-queue/entries/:id/withdraw         {reason}                                the owner
POST /api/merge-queue/entries/:id/operator-gate    {reference}                             Operator only
```

They are part of the unversioned `/api` family and refuse with its `{error, code}` body. `queueId`
is needed only by a project that owns more than one active queue.

### From a pane: `tc queue`

```
tc queue status
tc queue submit <pr> --head <sha> --review <ref> --test <ref> --base <ref> [--operator-gate required|none] [--queue <id>]
tc queue show <entry>
tc queue withdraw <entry> --reason <text>
```

`status` shows each queue's entries in order, each entry's state and each gate, and whose word each
one is. `--operator-gate` is `none` unless given. The verb is not in the list every pane is primed
with: `tc` with no verb lists it.

**How long `tc` waits.** `tc queue submit` and `tc queue withdraw` each wait 60 seconds for the
answer; `status` and `show` wait the 10 seconds every other `tc` call waits. A submit ordinarily
answers in a few seconds: the server reads GitHub several times for it, each read bounded at 10
seconds, and a withdrawal deletes up to two branches, each bounded at 20.

**When the wait runs out.** The server goes on working after `tc` stops waiting, so a submit or a
withdrawal that got no answer **may still be running, or may have finished**. `tc` says so, exits
2, and does not say the API is unreachable. Read `tc queue status` before repeating: the entry is
there or it is not. Repeating a submit that did go through is refused `DUPLICATE_PR`, naming the
entry; repeating a withdrawal is harmless. A `status` or `show` that got no answer changed nothing
and is repeated.

### What a submit records, and what the queue reads itself

The owner states three gates, each with a reference to where its result is recorded (a message id,
a run id, a commit): `review`, `test` and `base`. The queue records them and judges none of them.
The owner also says whether the entry needs the Operator gate. `required` leaves it open until the
Operator records it; an entry with an open Operator gate cannot land.

Before anything is queued, this server asks GitHub itself, and refuses on what it reads:

- the pull request is open, targets the queue's base branch, is not a draft, and its head is the
  submitted commit;
- the `test` check on that commit concluded `success` (its run id is kept with the entry);
- the pull request changes no release-trigger path (below).

A read that fails refuses the submit (`503 GITHUB_UNAVAILABLE`). Nothing is taken from the caller's
word about the pull request.

### A landing is never a release

The release workflow runs when a push to `main` changes `version.json`. The queue refuses a pull
request that changes `version.json` or `.github/workflows/release.yml`, at submit, from GitHub's own
list of the pull request's files (`RELEASE_TRIGGER_CHANGED`, naming the paths). A file list that
could not be read whole, or is at GitHub's cap, is a refusal and never "no such path found". A
version bump is merged by hand under [release-process.md](release-process.md), outside the queue.
The paths are one list, `RELEASE_TRIGGER_PATHS` in `lib/merge-queue-state.js`, and
`test/merge-queue-release-guard.test.js` fails if the release workflow comes to watch a path that
list does not name. The same refusal at landing time, against the candidate itself, comes with the
part that lands.

### Withdrawing

The owner withdraws an entry with a reason of at most 1000 characters. **The reason is checked
first:** one that is missing or too long is refused `400 INVALID_INPUT` before any branch is
touched, so nothing is deleted for a withdrawal that could not then be recorded.

**One at a time per queue.** A withdrawal holds its queue's slot from reading the entry's state to
recording it withdrawn. One that arrives while another call holds the slot changes nothing, deletes
nothing and is refused `409 QUEUE_CALL_IN_FLIGHT`: read `tc queue status`, then withdraw again if
the entry is still there. A submit does not take the slot (it only adds to the end), and two queues
do not block each other. The slot is held in the server's memory, so a restart frees it; every call
that takes it is harmless to repeat.

An entry whose candidate exists, or is being made, has
both of its branches deleted on GitHub first (`discardCandidate`). If either could not be removed
the entry **stays in the queue** and the answer says what happened to each branch
(`503 CANDIDATE_NOT_DISCARDED`); withdraw again, which is harmless. An entry whose merge has been
asked for cannot be withdrawn: the merge's outcome is read first. Withdrawing is the only thing
these routes change on GitHub, and only those two branches.

### Refusals

Every refusal carries a `code` and says what to do next.

| Code | Status | Meaning |
|---|---|---|
| `CALLER_NOT_VERIFIED` | 403 | not the Operator and not a verified launch |
| `OPERATOR_UNVERIFIABLE` | 503 | an operator-shaped request this install cannot verify; sign in |
| `OPERATOR_ONLY` | 403 | making a queue or recording the Operator gate, by anyone else |
| `NOT_OWNER` | 403 | submitting or withdrawing, by anyone but the owner's launch |
| `CONTROL_HELD`, `CONTROL_STOPPED` | 423 | the owner's lane is held or stopped; it cannot submit |
| `INVALID_INPUT`, `GATE_REFERENCE_MISSING` | 400 | a malformed request, a withdrawal's reason over 1000 characters included; a gate with no reference (`gate` names it) |
| `QUEUE_NOT_FOUND`, `ENTRY_NOT_FOUND`, `PROJECT_NOT_FOUND` | 404 | no such thing, or not readable by this caller |
| `QUEUE_AMBIGUOUS` | 400 | the owner has more than one queue; send `queueId` |
| `QUEUE_EXISTS`, `QUEUE_RETIRED` | 409 | a second queue for the same base; a queue that takes nothing new |
| `DUPLICATE_PR` | 409 | the pull request already has an unfinished entry (`entryId`) |
| `PR_NOT_OPEN`, `PR_WRONG_BASE`, `PR_HEAD_MOVED`, `PR_DRAFT` | 409 | what GitHub says of the pull request |
| `HEAD_CHECK_NOT_GREEN` | 409 | the head's `test` check is missing, running or not `success` |
| `RELEASE_TRIGGER_CHANGED` | 409 | the pull request changes a release-trigger path (`paths`) |
| `GITHUB_UNAVAILABLE` | 503 | a read from GitHub failed; nothing was queued |
| `CANDIDATE_NOT_DISCARDED` | 503 | a withdrawal could not remove both branches; the entry stays |
| `QUEUE_CALL_IN_FLIGHT` | 409 | another withdrawal of this queue is running; nothing was changed. Read the queue, then repeat |
| `ENTRY_FINISHED`, `TRANSITION_NOT_ALLOWED` | 409 | the entry is done, or its merge has been asked for |
| `OPERATOR_GATE_NOT_REQUIRED`, `OPERATOR_GATE_ALREADY_RECORDED` | 409 | the Operator gate has nothing to record |
| `ENTRY_ID_UNUSABLE` | 500 | a defect: the queue made an id no branch can be named after. `withdrawn` says whether it took the entry back out; if not, the entry is still queued and these routes cannot reach it |
| `MERGE_QUEUE_UNAVAILABLE` | 503 | the queue could not answer; read it before repeating |

Three refusals come from the layers in front of every route and are not the queue's own:
`403 LAUNCH_BINDING_REQUIRED` or `LAUNCH_BINDING_INVALID` (a write with no launch headers, or with
those of a launch that has ended or been replaced), `403 CSRF_TOKEN_INVALID` (a signed-in write
without the session's token) and `503 CONTROL_STATE_UNAVAILABLE` (the HOLD state could not be read,
so a submit is refused).

### Limits

- **A held owner can still withdraw.** The durable HOLD ([control-state.md](control-state.md))
  refuses a submit; a withdrawal takes work out of the queue and is not held.
- **A coordinator in a context rotation is not fenced from these routes.** The rotation gate does
  not know them.
- **No answer carries a launch id.** An entry shows which project submitted it, not which launch.
- **Making the queue from the browser console has not been run in a browser.** A test makes a
  queue as a signed-in Operator with the session's token; the console command itself is first run
  by the Operator, after the deploy.

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
| `readBranchCheck` | `GET /repos/{repo}/commits/{sha}/check-runs`, then `GET /repos/{repo}/commits/{sha}/check-suites` | nothing |

A commit's check runs are also read by `lib/github-checks.js` (`GET /repos/{repo}/commits/{sha}/check-runs`),
which changes nothing and answers the newest run of a name on the commit, whichever branch it was
made for. `readBranchCheck` answers the newest run made for one branch, and nothing in the queue
calls it yet.

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
  `stage` or the `candidate`) or `unavailable`. A stage branch is left untouched only when
  GitHub's "already exists" was read: when creating it timed out or answered a server error,
  `createCandidate` deletes that name without knowing it made it. That is safe while one owner
  advances one entry at a time, which is the only way the queue runs. `created` means all of it: the merge was read back,
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

On the same day, after the workflow had its `tc-queue/**` trigger, more was tried, each time
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
