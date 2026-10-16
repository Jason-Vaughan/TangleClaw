# The merge queue

*(#2322.) A queue can be made, submitted to, read, withdrawn from and advanced, and the Operator
gate can be recorded. **Nothing lands by itself:** a pull request lands only when the queue's owner
advances the queue, one step a call, and there is no timer. There is no screen.*

## Using the queue

A queue belongs to one repository and base branch and has one owner project. An entry is one pull
request at one exact head commit.

| Who | May |
|---|---|
| The Operator | make a queue and name its owner; record an entry's Operator gate; clear a queue's halt; read |
| A verified live launch of the owner project | submit an entry; withdraw an entry; advance the queue; read |
| A project that shares a group with the owner | read |
| Anyone else | nothing. A queue they may not read does not exist for them (`404`) |

"Verified live launch" means the request carries `x-tangleclaw-project-id` and
`x-tangleclaw-launch-id` of that project's active session; `tc` sends them. The Operator is not the
owner and cannot submit, withdraw or advance. The owner cannot record the Operator gate: a session
saying the Operator agreed is not the Operator.

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
POST /api/merge-queue/advance                      {queueId?}                              the owner
POST /api/merge-queue/:id/clear-halt               {reference}                             Operator only
POST /api/merge-queue/entries/:id/operator-gate    {reference}                             Operator only
POST /api/merge-queue/entries/:id/settle-landing   {outcome: "landed"|"failed", sha?,
                                                    mergeAttempt?, reference, attestation}  Operator only
```

They are part of the unversioned `/api` family and refuse with its `{error, code}` body. `queueId`
is needed only by a project that owns more than one active queue.

### From a pane: `tc queue`

```
tc queue status
tc queue submit <pr> --head <sha> --review <ref> --test <ref> --base <ref> [--operator-gate required|none] [--queue <id>]
tc queue show <entry>
tc queue withdraw <entry> --reason <text>
tc queue advance [--queue <id>]
```

`status` shows each queue's entries in order, each entry's state and each gate, and whose word each
one is. `--operator-gate` is `none` unless given. The verb is not in the list every pane is primed
with: `tc` with no verb lists it.

**How long `tc` waits.** `tc queue submit` and `tc queue withdraw` each wait 60 seconds for the
answer and `tc queue advance` waits 180; `status` and `show` wait the 10 seconds every other `tc`
call waits. Each ordinarily answers in a few seconds: the server reads GitHub several times for a
submit, each read bounded at 10 seconds, and a withdrawal deletes up to two branches, each bounded
at 20. An advance does one step and no more, so its longest case is bounded too: making a candidate
is at most 170 seconds (three reads, the candidate at up to 90, and removing what a failed attempt
left at up to 40), and landing is at most 150.

**When the wait runs out.** The server goes on working after `tc` stops waiting, so a submit, a
withdrawal or an advance that got no answer **may still be running, or may have finished**. `tc`
says so, exits 2, and does not say the API is unreachable. Read `tc queue status` before repeating:
the entry is there or it is not, and its state says how far an advance got. Repeating a submit that
did go through is refused `DUPLICATE_PR`, naming the entry; repeating a withdrawal is harmless;
repeating an advance does the next step, and never asks for a merge that was already asked for. A
`status` or `show` that got no answer changed nothing and is repeated.

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
list does not name. The same refusal is made again at landing time, against the candidate itself:
in the call that merges, after the base branch is read unchanged and before the merge is asked for,
the queue reads what the candidate changes on the base branch, and a release-trigger path, a list
that could not be read or a list at GitHub's cap fails the entry and nothing is merged.

## Advancing: how a pull request lands

`tc queue advance` (`POST /api/merge-queue/advance`) moves the entry at the front of the owner's
queue **one step** and answers what it did: a `step` word, whether anything was `changed`, a
sentence, and the entry as the queue now holds it. Only the owner's verified live launch may call
it. Nothing else advances a queue: there is no timer, so with the owner away nothing lands.

### The procedure, for the owner

1. `tc queue submit` each reviewed pull request at its exact head, in the order they should land.
2. `tc queue advance`. The front entry's candidate is made: its head merged into the tip of the base
   branch, on the branch `tc-queue/<entry id>`, where CI tests it. The entry is `testing`.
3. Wait for the candidate's `test` check. `tc queue advance` while it runs answers `waiting` and
   changes nothing, so asking early costs nothing.
4. `tc queue advance` once it has concluded. Everything in the table below is read again, and if all
   of it holds the pull request is merged and the entry is `landed`.
5. `tc queue advance` again for the next entry. Its candidate is made on the base branch as it is
   after that landing, with nothing for its author to do.

One entry at a time holds the queue: a second entry is never assembled while the first is
`assembling`, `testing` or `landing`.

### What one call does

| The front entry is | The call | Then the entry is |
|---|---|---|
| `queued` | reads the pull request, the base branch's tip and its `test` check, then makes the candidate | `testing` |
| `assembling` (an earlier call was cut short) | the same, starting over | `testing` |
| `testing`, base branch moved since the candidate was made | deletes the candidate's branches; not a failure | `assembling` |
| `testing`, candidate's check not concluded | nothing (`waiting`) | `testing` |
| `testing`, everything holds | merges the pull request, compares trees, deletes the candidate's branches | `landed` |
| `landing` (a merge was asked for and its outcome was not recorded) | reads the pull request and records what happened; never merges | `landed` or `testing` |
| nothing waiting | nothing (`idle`) | |

Two more steps keep GitHub clean. If a landing's branches could not be deleted, the next call
deletes them and does nothing else (`cleaned-up`); the server remembers which landings are clean
only in memory, so the first advance after a restart may repeat that removal once, harmlessly. If a
branch is already there when a candidate is to be made, the call deletes it and makes no candidate
(`assembly-retry`); if it is there again on the next call, that call stops for a person
(`CANDIDATE_REF_EXISTS`).

### What a landing rests on, and what happens when it does not hold

Each of these is read from GitHub or the queue's own records **in the call that merges**. Nothing is
taken from the caller, and nothing lands on a read that was not made.

| What is read | If it does not hold |
|---|---|
| The caller is the owner's live launch, admitted by its coordinator rotation, and not held | refused; nothing changed |
| The pull request is open, not a draft, on the queue's base, at the submitted head | the entry **fails** (`PR_NOT_OPEN`, `PR_DRAFT`, `PR_WRONG_BASE`, `PR_HEAD_MOVED`) |
| The base branch is where it was when the candidate was made | the candidate is discarded and made again; not a failure |
| The submitted head merges cleanly into the base branch, and adds something to it, when the candidate is made | it conflicts: the entry **fails** (`CANDIDATE_CONFLICT`). The base branch already holds that head: the entry **fails** (`NOTHING_TO_MERGE`). Either way no candidate branch is left, and the next entry is at the front |
| The candidate's `test` check, as run for the candidate branch, concluded `success` | still running or not started: `waiting`. Any other conclusion: the entry **fails** (`CANDIDATE_NOT_GREEN`) |
| The base branch's own `test` check, as run for that branch, is not red | red: refused `BASE_NOT_GREEN`, nothing changed. Still running: `waiting`, unless the base is this queue's own landing of a tree its candidate's check passed on |
| Every gate is recorded, the Operator gate included when the entry needs it | refused `GATES_NOT_MET`, naming each; nothing changed |
| Landing changes no release-trigger path | the entry **fails** (`RELEASE_TRIGGER_CHANGED`), also when the list could not be read whole |
| Any of those reads could not be made | refused `503 GITHUB_UNAVAILABLE` with the reader's own reason; nothing changed |
| The owner's inbox holds no unhandled message: read last, from the in-memory inbox of the session behind the launch this call was verified as, with nothing waited on between it, the caller's admission and the merge request | an unhandled message: refused `AUTHORIZER_MESSAGE_UNREAD`, naming each by id and sender; an inbox that cannot be read: refused `AUTHORIZER_INBOX_UNREADABLE`. Nothing changed either way |

A check is judged only by runs made for the branch being judged (`readBranchCheck`): a run another
branch's push made on the same commit never stands in, whatever it concluded, and a list of runs or
suites that could not be read whole is `GITHUB_UNAVAILABLE`, never "no run" and never a result. The
base branch is also checked before a candidate is made: none is made on a red base.

**The owner's inbox.** A message blocks because nobody has handled it, whatever it says: an approval
nobody read is not an approval, and an objection nobody read still stands. Read each message in full,
answer it where an answer is owed, mark it handled (`tc message ack`), then advance again. Handling a
message is not an authorization and resolves no HOLD; every other gate stays. Server-origin notices
(an envelope from `system`, such as a shared document's update notice) are counted and do not block,
and the test is the envelope's sender, never what the body says. The inbox cannot be read, and the
landing is refused, when the session's Medusa listener is not listening (an inbox nobody is filling
reads as empty) or when the launch the call was verified as has since ended or been replaced. An owner
project without the switchboard therefore cannot land through the queue. Only a landing reads the
inbox: making a candidate, discarding one, failing an entry and removing a landing's branches do not.
The `landing-started` event records whose inbox was read (project, launch, session), when, the
listener's state, how many system notices were left out, and the head, base and candidate; it records
no message.

The merge is a true merge commit pinned to the submitted head. Afterwards the merge commit's tree is
compared with the candidate's. **If they differ the landing is still recorded, because the merge
happened, and the queue halts itself:** every further advance is refused `QUEUE_HALTED` until the
Operator clears the halt, because the base branch then holds a tree no test passed.

### Clearing a halt (the Operator)

A halt is cleared by the Operator and nobody else, with a sentence saying what was checked or
decided about the base branch. There is no screen. On the signed-in dashboard, in the browser's
console, with the queue's id (`tc queue status` prints it on the `HALTED` line's queue):

```js
tcFetch('/api/merge-queue/mq_0123456789abcdef/clear-halt', {  // the halted queue's id
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reference: 'what was checked or decided, in at most 300 characters' })
}).then((r) => r.json()).then(console.log);
```

The answer is the queue, no longer halted, and `cleared`, the halt that was lifted. The history gets
`queue-halt-cleared` with the Operator's proof tier, the reference, and the halt's code and time. A
project launch is refused `403 OPERATOR_ONLY`, the owner included; a queue that is not halted is
refused `409 QUEUE_NOT_HALTED`; a missing reference `400 INVALID_INPUT`. Clearing a halt changes
nothing on GitHub and lands nothing: it lets the owner advance again.

### A failed entry, and a candidate's branches

A failed entry is out of the queue and the next one is at the front; its pull request is untouched
and can be submitted again. An entry that has or may have a candidate loses both branches **before**
it is failed. If either could not be deleted the entry stays as it is and the call is refused
`503 CANDIDATE_NOT_DISCARDED`, saying what happened to each branch; the next advance tries again. A
landing is recorded first and its branches deleted after, so a landing whose branches could not be
deleted is still a landing, and what waits is the next entry's candidate.

### A merge whose answer was not read

Asking GitHub to merge can time out after the merge was made. The entry is marked `landing` before
the request is sent, and from then on no call sends a second one: the pull request is read, and the
entry is recorded as what it became. Merged: `landed`, with the tree compared. Still open: back to
`testing` with its candidate (`landing-not-made`), for the next advance to check everything anew.
When that read also fails the entry stays `landing` and the answer says so (`landing-unknown`); the
next advance starts by reading it again. An entry that is `landing` cannot be withdrawn.

**Which commit is the landing.** The merge request's own answer names it, and when that answer was
lost, the pull request does: GitHub's `merge_commit_sha`, taken only from a pull request read as
closed and merged. (GitHub gives an open pull request a commit under the same name, a trial merge
that is on no branch; `readPull` never answers that one.) Either way that exact commit is then
read, and it is recorded as the landing only if it is a merge whose second parent is the submitted
head. A commit that cannot be read, a merged pull request with no commit named, or a commit that is
not that merge leaves the entry `landing` and says why: nothing is recorded on a guess, and the
base branch's tip never stands in. A merge that was made on a base that had moved since the candidate
was made is still this entry's landing and is recorded; the tree comparison then decides, halting
the queue when the base branch does not hold the tested tree, and the answer says which base it was
merged onto.

### Settling a stuck landing (the Operator)

A merged pull request that GitHub will not name a landing for (no merge commit, or one that is not a
merge of the submitted head) leaves its entry `landing`, and nothing behind it advances. The Operator
settles it, and nobody else can: a project launch is refused `403 OPERATOR_ONLY`, the owner
included. There is no screen. On the signed-in dashboard, in the browser's console:

```js
tcFetch('/api/merge-queue/entries/mqe_0123456789abcdef/settle-landing', {  // the landing entry's id
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    outcome: 'landed',                 // or 'failed'
    sha: '<the full 40-character commit on the base branch>',  // landed only
    reference: 'what was checked or decided, in at most 300 characters',
    attestation: 'how the commit, or the failure, relates to this pull request, in at most 1000 characters'
  })
}).then((r) => r.json()).then(console.log);
```

Only an entry in `landing` is settled; any other is refused `409` with nothing read. A settlement
holds the queue's slot, as an advance and a withdrawal do, so it never runs beside either: one that
finds the slot taken is refused `409 QUEUE_CALL_IN_FLIGHT`. Inside the slot the entry is read again,
and the store checks it is still `landing` in the write itself, so of two settlements one is recorded.
Every GitHub read a settlement needs is required: one that fails refuses it `503` and changes nothing.

**`landed`.** The named commit is read (`503 SETTLE_COMMIT_UNREADABLE` when it cannot be), the base
branch's tip is read now, and the commit must be reachable from that tip (`readAncestry`): the tip is
the commit or a descendant of it. A commit that has diverged from the base or is ahead of it is
refused `409 SETTLE_NOT_ON_BASE`. The tip never stands in for the commit. The entry is recorded
`landed` at that commit, with what was read: the tip, the comparison's status, the commit's tree and
parents, whether a parent is the submitted head, and the pull request's `merge_commit_sha` as read
now. The tree is a separate check: the candidate's tree clears no halt; any other tree halts the
queue `TREE_MISMATCH`.

**`failed`** is a disposition the Operator makes on evidence; no advance ever records it. The pull
request is read now and recorded. A pull request read back unmerged shows only what GitHub reported
at that read, not that the merge request cannot still complete, so the queue is halted
`LANDING_SETTLED_UNRECONCILED` unless the Operator sends `mergeAttempt: 'unsuccessful'`, disposing
of the merge request. A pull request read back merged always halts it so. The entry's failure code
is `LANDING_SETTLED_FAILED`. Nothing advances on that halt until the Operator, having reconciled the
base branch, clears it ("Clearing a halt").

A queue that is already halted keeps its halt, code and detail unchanged either way. A settlement
that would itself halt the queue (a tree that is not the tested one, or an unreconciled failure)
records its reason as a further `queue-halted` event that names the halt it left in place; one that
would not adds nothing, and the answer's `settlement.haltReasonRecorded` says which.

**The candidate's branches** are removed only after the settlement is recorded, and only the entry's
own recorded candidate branch: one name directly under `tc-queue/`, and its stage branch, never a name
made from the entry's id, never a branch another unfinished entry records. Anything else is reported
in `cleanup` as `skipped` and left alone. A removal that fails (`cleanup.status: 'failed'`) leaves the
settlement standing, and the next advance retries it under the same checks.

The answer is the entry, the queue, `settlement` (its `case`, whether a halt stands and whether an
earlier one was kept, what was read) and `cleanup`. The history gets the entry's `landed` or `failed`
event with the Operator's proof tier, `settledBy: 'operator'`, the reference, the attestation and what
was read. Settling merges, deploys and releases nothing.

### Four separate facts

A landing is one of four things that are easy to say as one and are not:

| Fact | Who makes it true | What the queue says about it |
|---|---|---|
| **Merged**: the pull request's commits are on the base branch | this queue, by a landing | `landed`, with the merge commit and whether its tree is the tested one |
| **Batch complete**: every pull request of a batch is merged and its records are written | the batch's coordinator | nothing: the queue knows entries, not batches |
| **Deployed**: an install is running the merged code | whoever deploys, by the deploy procedure | nothing: a landing starts no deploy and restarts nothing |
| **Released**: a version is tagged and published | the release process ([release-process.md](release-process.md)) | nothing: a landing cannot change a release-trigger path, so it is never a release |

A landing writes one record, the merge. `tc queue status` showing `landed` means merged and nothing
more.

### Withdrawing

The owner withdraws an entry with a reason of at most 1000 characters. **The reason is checked
first:** one that is missing or too long is refused `400 INVALID_INPUT` before any branch is
touched, so nothing is deleted for a withdrawal that could not then be recorded.

**One at a time per queue.** A withdrawal and an advance each hold their queue's slot from reading
the entry's state to recording the change. One that arrives while another call holds the slot
changes nothing, deletes nothing and is refused `409 QUEUE_CALL_IN_FLIGHT`: read `tc queue status`,
then repeat it if it is still wanted. A submit does not take the slot (it only adds to the end), and
two queues do not block each other. The slot is held in the server's memory, so a restart frees it; every call
that takes it is harmless to repeat.

An entry whose candidate exists, or is being made, has
both of its branches deleted on GitHub first (`discardCandidate`). If either could not be removed
the entry **stays in the queue** and the answer says what happened to each branch
(`503 CANDIDATE_NOT_DISCARDED`); withdraw again, which is harmless. An entry whose merge has been
asked for cannot be withdrawn: the merge's outcome is read first. A withdrawal changes nothing on
GitHub but those two branches.

### An owner in a context rotation

A submit, a withdrawal and an advance are the owner acting as a coordinator, so each is judged by
the coordinator epoch gate ([coordinator-rotation.md](coordinator-rotation.md)) exactly as a control
command is. Launch binding proves the owner's launch is live; the gate adds that the calling
context is the one the owner's rotation bound.

| The owner's latest rotation | Submit, withdraw and advance |
|---|---|
| none, or `abandoned` | accepted as before: the project is not judged |
| `fenced` or `rebinding` | refused, `409 COORDINATOR_FENCED`: no replacement context is bound yet |
| `reconciling` | refused, the bound replacement included: a queue change waits for the resume |
| `active` | accepted only from the bound replacement; a stale or other thread of the same live launch is refused `409 COORDINATOR_EPOCH_MISMATCH` |

- **The gate is asked more than once.** At the start of the request, and again after every wait,
  immediately before the queue is written, a branch is deleted or a merge is asked for. A rotation
  that begins while a submit is reading GitHub queues nothing. One that begins while a withdrawal
  is deleting branches leaves the entry in the queue: the replacement context withdraws it again,
  which is harmless. One that begins while an advance is reading for a landing prevents the merge:
  it is never asked for and the entry is unchanged.
- **A merge that was asked for is finished, whoever is asking by then.** Nothing waits between the
  gate's last answer and the merge request. If a rotation begins after the request was sent, its
  outcome is still read and recorded, so a merge that happened is never left out of the queue. No
  branch is deleted for the replaced context and no second merge is asked for; the replacement's
  next advance deletes the candidate's branches.
- **A refusal is logged.** The server log gets `Coordinator epoch gate refused a mutation` with the
  owner project, the action `merge-queue-mutate`, the code and the rotation, as for every other
  gated command.
- **Call through `tc`.** `tc` forwards the engine thread (`x-tangleclaw-engine-thread`, from
  Codex's `CODEX_THREAD_ID`). While an epoch is active, a call without that header is refused and
  says so.
- **What is not gated.** Reading (`tc queue status`, `tc queue show`), and everything the Operator
  does: making a queue, recording the Operator gate and clearing a halt.
- **Which refusal comes first.** Who the caller is and whether it owns the queue are settled before
  the gate is asked: a caller that is not a verified launch, or not the owner, gets that refusal
  (`CALLER_NOT_VERIFIED`, `NOT_OWNER`, a queue or entry it may not read as `404`) whatever the
  rotation says. Every other refusal comes after the gate: `CONTROL_HELD`, `QUEUE_RETIRED`,
  `INVALID_INPUT`, `DUPLICATE_PR`, and what an entry's state does not allow.

### Refusals

Every refusal carries a `code` and says what to do next.

| Code | Status | Meaning |
|---|---|---|
| `CALLER_NOT_VERIFIED` | 403 | not the Operator and not a verified launch |
| `OPERATOR_UNVERIFIABLE` | 503 | an operator-shaped request this install cannot verify; sign in |
| `OPERATOR_ONLY` | 403 | making a queue, recording the Operator gate, clearing a halt or settling a stuck landing, by anyone else |
| `NOT_OWNER` | 403 | submitting, withdrawing or advancing, by anyone but the owner's launch |
| `CONTROL_HELD`, `CONTROL_STOPPED` | 423 | the owner's lane is held or stopped; it cannot submit or advance |
| `COORDINATOR_FENCED`, `COORDINATOR_EPOCH_MISMATCH` | 409 | the owner's context rotation does not admit this caller for a submit, a withdrawal or an advance (`rotationId`); nothing was changed, except that a call overtaken while deleting may have removed the candidate's branches, and an advance overtaken while a candidate was being made leaves that branch for the next advance to remove |
| `INVALID_INPUT`, `GATE_REFERENCE_MISSING` | 400 | a malformed request, a withdrawal's reason over 1000 characters included; a gate with no reference (`gate` names it) |
| `QUEUE_NOT_FOUND`, `ENTRY_NOT_FOUND`, `PROJECT_NOT_FOUND` | 404 | no such thing, or not readable by this caller |
| `QUEUE_AMBIGUOUS` | 400 | the owner has more than one queue; send `queueId` |
| `QUEUE_EXISTS`, `QUEUE_RETIRED` | 409 | a second queue for the same base; a queue that takes nothing new and advances nothing |
| `QUEUE_HALTED`, `QUEUE_NOT_HALTED` | 409 | the queue is halted (`halt`): on a landed tree that was not the tested one (`TREE_MISMATCH`), or on a settled failure whose merge may have happened (`LANDING_SETTLED_UNRECONCILED`), and nothing advances until the Operator clears it; clearing a queue that is not halted |
| `DUPLICATE_PR` | 409 | the pull request already has an unfinished entry (`entryId`) |
| `PR_NOT_OPEN`, `PR_WRONG_BASE`, `PR_HEAD_MOVED`, `PR_DRAFT` | 409 | what GitHub says of the pull request |
| `HEAD_CHECK_NOT_GREEN` | 409 | the head's `test` check is missing, running or not `success` |
| `RELEASE_TRIGGER_CHANGED` | 409 | the pull request changes a release-trigger path (`paths`) |
| `GITHUB_UNAVAILABLE` | 503 | a read from GitHub failed (`reason`); nothing was queued, an advance moved nothing, and a settlement changed nothing. From an advance it also means a candidate could not be made: what it may have left was removed (`branches`) and the entry is `assembling` |
| `BASE_NOT_GREEN` | 409 | the base branch's own `test` check concluded something other than `success` (`check`); nothing is assembled or landed, nothing was changed |
| `GATES_NOT_MET` | 409 | a green entry has a gate that is not recorded (`problems` names each); nothing was changed |
| `AUTHORIZER_MESSAGE_UNREAD` | 409 | the owner's inbox holds an unhandled message (`messages`, each by `id` and `from`, never its text); nothing was changed. Handle it, then advance again |
| `AUTHORIZER_INBOX_UNREADABLE` | 409 | the owner's inbox could not be read (`reason`): the session's listener is not listening, or the launch has ended or been replaced; nothing was changed |
| `CANDIDATE_REF_EXISTS` | 409 | a candidate branch was there again after the queue removed it (`ref`, `existing`); nothing was changed, and it needs a person |
| `CANDIDATE_NOT_DISCARDED` | 503 | a withdrawal or an advance could not remove both of a candidate's branches (`candidate`, `stage`); the entry stays as it was |
| `QUEUE_CALL_IN_FLIGHT` | 409 | another withdrawal, advance or settlement of this queue is running; nothing was changed. Read the queue, then repeat |
| `SETTLE_NOT_ON_BASE` | 409 | the commit a settlement names is not reachable from the base branch's tip (`compareStatus`); nothing was changed |
| `SETTLE_COMMIT_UNREADABLE` | 503 | the commit a settlement names could not be read (`reason`); nothing was changed |
| `ENTRY_FINISHED`, `TRANSITION_NOT_ALLOWED` | 409 | the entry is done, or its merge has been asked for; a settlement's entry is not `landing` |
| `OPERATOR_GATE_NOT_REQUIRED`, `OPERATOR_GATE_ALREADY_RECORDED` | 409 | the Operator gate has nothing to record |
| `ENTRY_ID_UNUSABLE` | 500 | a defect: the queue made an id no branch can be named after. `withdrawn` says whether it took the entry back out; if not, the entry is still queued and these routes cannot reach it |
| `MERGE_QUEUE_UNAVAILABLE` | 503 | the queue could not answer; read it before repeating |

Three refusals come from the layers in front of every route and are not the queue's own:
`403 LAUNCH_BINDING_REQUIRED` or `LAUNCH_BINDING_INVALID` (a write with no launch headers, or with
those of a launch that has ended or been replaced), `403 CSRF_TOKEN_INVALID` (a signed-in write
without the session's token) and `503 CONTROL_STATE_UNAVAILABLE` (the HOLD state could not be read,
so a submit or an advance is refused).

### Limits

- **A held owner can still withdraw.** The durable HOLD ([control-state.md](control-state.md))
  refuses a submit and an advance; a withdrawal takes work out of the queue and is not held. A hold
  stored after a merge was asked for does not stop that merge's outcome being recorded.
- **A landing GitHub will not name stays `landing` until the Operator settles it.** No advance moves
  such an entry; the Operator does ("Settling a stuck landing"). A settlement proves where a commit
  is, never that a merge request can no longer complete, which is why a settled failure halts the
  queue unless the Operator disposes of the merge request.
- **A skipped branch is reported, never recorded or promised a retry.** When a settlement's cleanup,
  or an advance's retry of it, finds a recorded branch the queue may not delete, the skip appears in
  that call's answer (`cleanup`, or `cleanupSkipped`) and in the server's log, and nowhere in the
  queue's history. An advance reports it only while that entry is the latest one owing cleanup; once
  a later entry lands, nothing reports it again. The branch is left as it is, and nothing says it was
  cleaned: a person removes it if it should go.
- **Settling from the browser console has not been run in a browser.** Tests settle as the Operator
  over HTTP against a faked GitHub; the console command itself is first run by the Operator.
- **The inbox check guards the queue's merge only.** A pull request merged by hand (`gh pr merge`, the
  GitHub page) passes no check of this queue, and nothing here can guard a shell command.
- **The inbox check is a snapshot of the local inbox.** It sees what has reached this server's
  listener when it is read. A message still in transit, or one that arrives after the merge request
  was sent, is not seen.
- **A sender that reaches the Bridge directly can pass as a system notice.** TangleClaw fills a
  message's `from` from the sending session's own workspace id, so no sender routed through
  TangleClaw can call itself `system`. A process that reaches the Bridge's loopback endpoint directly
  can set `from`, and its message would be counted as a notice; the inbox's own drain of system
  notices accepts the same boundary.
- **Nothing has been landed on GitHub by this code.** Every test of an advance runs against a faked
  GitHub. The first real landing is the check after the deploy.
- **Clearing a halt from the browser console has not been run in a browser.** A test clears one as
  a signed-in Operator; the console command itself is first run by the Operator.
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
| `readPull` | `GET /repos/{repo}/pulls/{number}` (with the commit a merged one was merged as) | nothing |
| `readPullFiles` | the same, then `GET /repos/{repo}/pulls/{number}/files`, every page | nothing |
| `readRefTip` | `GET /repos/{repo}/git/ref/heads/{branch}` | nothing |
| `readCommit` | `GET /repos/{repo}/git/commits/{sha}` | nothing |
| `readCompareFiles` | `GET /repos/{repo}/compare/{base}...{head}` | nothing |
| `readAncestry` | `GET /repos/{repo}/compare/{sha}...{tip}`, the same call | nothing |
| `createCandidate` | `POST /repos/{repo}/git/refs`, `POST /repos/{repo}/merges`, `GET /repos/{repo}/git/commits/{sha}`, `POST /repos/{repo}/git/refs`, `DELETE /repos/{repo}/git/refs/heads/{branch}` | creates one branch under `tc-queue-stage/`, puts one merge commit on it, creates one branch under `tc-queue/` at that commit, and deletes the first branch |
| `discardCandidate` | `DELETE /repos/{repo}/git/refs/heads/{branch}`, twice | deletes one branch under `tc-queue/` and the branch of the same name under `tc-queue-stage/` |
| `deleteRef` | `DELETE /repos/{repo}/git/refs/heads/{branch}` | deletes one branch under `tc-queue/` or `tc-queue-stage/` |
| `mergePull` | `PUT /repos/{repo}/pulls/{number}/merge` | merges one pull request into its base branch |
| `readBranchCheck` | `GET /repos/{repo}/commits/{sha}/check-runs`, then `GET /repos/{repo}/commits/{sha}/check-suites` | nothing |

A commit's check runs are also read by `lib/github-checks.js` (`GET /repos/{repo}/commits/{sha}/check-runs`),
which changes nothing and answers the newest run of a name on the commit, whichever branch it was
made for. `readBranchCheck` answers the newest run made for one branch, and is what an advance
judges the base branch and a candidate by.

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
