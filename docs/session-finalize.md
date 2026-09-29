# Governed Session Finalization (Self-Wrap)

A session that has finished its work, reconciled it and drained its mail can be
retired **headlessly**: no wrap drawer, no wrap pipeline and no git. Either the
session does it itself, or the coordinator that governs it does. This path is for
the case where there is nothing left to decide. Whenever something is left to
decide, it refuses and points to the full wrap: uncommitted work of the session's
own, commits no remote has, or a wrap already under way.

Issue: #2027. Implementation: `lib/session-finalize.js` decides and
`sessions.finalizeSession` performs.

## Using it

```
tc finalize --reason "<why>"                                  # retire this pane's own session
tc finalize --session <id> --reason "<why>"                   # name a session of this pane's own project
tc finalize --project <name> --session <id> --reason "<why>"  # a coordinator retires its governed target
```

Before a session finalizes itself, it reports itself done:

```
tc workload set complete --clearance safe-to-clear --summary "<what was finished>"
tc finalize --reason "<why>"
```

When a session finalizes itself, its own pane is torn down while the request is
running, so the success line may never print. The outcome can be confirmed by
repeating the request with the session named, by a caller whose authority still
covers that session:
- the coordinator, with `--project` and `--session`;
- the finalized session's own launch, with `tc finalize --session <id>`, when its
  pane survived (a teardown that could not kill it). Once the session has ended, a
  bare `tc finalize` has no active session to name, and it says so.

A later session of the same project has its own launch, and its authority covers
only itself, so naming the earlier session from there answers `SESSION_CHANGED`.

Exit codes:
- `0`: finalized, or already finalized;
- `1`: usage;
- `2`: the API could not be asked;
- `3`: not finalized as asked. That is either a refusal, which prints its code
  and facts and `Nothing was changed.`, or `FINALIZE_INCOMPLETE`: the session is
  recorded finalized, but publishing or teardown is unfinished. That prints what
  is left and `Repeat the same command to finish.`

## API

```
POST /api/sessions/:project/finalize
{ "sessionId": 1220, "reason": "chunk merged; lane retired" }
```

The request must carry a verified launch binding (`x-tangleclaw-project-id` and
`x-tangleclaw-launch-id`, which `tc` sends). `sessionId` is required: it is the
session the caller observed, so a relaunch between observing and asking can never
retire the wrong one. `reason` is 1–500 characters, collapsed to one line: it is written into the next session's handoff.

`200` answers `{ ok: true, alreadyFinalized, mode: "self"|"delegated", session: {id, projectId, status, endedAt, wrapSummary}, publication: {id, digest, state, reason}, teardown: {steps, surviving} }`.

## Who may finalize

| Caller | May finalize |
| --- | --- |
| The session itself (verified launch of the target project) | Only its own session. |
| A principal in the target's open control assignment's `authority.lifecycle` | Only the session that assignment is bound to. |
| Anyone else: a peer outside the matrix, another project, the operator, the Master, an unbound request | Nothing (`403 FINALIZE_UNAUTHORIZED`). |

A coordinator in the middle of a managed context rotation (#2032) is fenced
like any other coordinator mutation. This covers both finalizing its own lane
(a wrap) and retiring another lane under lifecycle authority (a control
mutation).

The operator is deliberately not a caller. The operator already has the wrap
drawer and kill, and when the auth gate is open an operator-shaped request can be
forged by any local process.

## Preconditions

They are checked in this order. The first one that fails refuses the request, and
nothing is changed.

| # | Check | Refusal |
| --- | --- | --- |
| 1 | Body has a `sessionId` and a `reason` | `400 BAD_REQUEST` |
| 2 | The caller is a verified launch | `403 FINALIZE_UNAUTHORIZED` |
| 3 | The caller has authority over the target (table above) | `403 FINALIZE_UNAUTHORIZED`; `503 CONTROL_STATE_UNAVAILABLE` when the assignment's authority matrix cannot be read |
| 4 | The named session belongs to the project | `404 SESSION_NOT_FOUND` |
| 5 | The named session is the one the caller's authority covers: its own session for self, the assignment's bound session for a coordinator | `403 FINALIZE_UNAUTHORIZED` if that other session is live, `409 SESSION_CHANGED` if it has ended |
| 6 | The named session is still active. If this path already ended it, the answer is the idempotent `200 {alreadyFinalized: true}`; a session the wrap ended, or one killed or crashed, is not reported as finalized | `409 SESSION_CHANGED` |
| 7 | The lane is not held or stopped (the control gate) | `423` with the gate's code |
| 8 | No wrap run is live | `409 WRAP_IN_PROGRESS` |
| 9 | The lane composes `AVAILABLE` (see below) | `409 NOT_CLEAR`, with the verdict, the reasons and the receipt's stale reason |
| 10 | The lane is drained (see below) | `409 EXCHANGES_OPEN`, naming the `unacknowledged`, `unanswered` and `awaitingReply` exchanges |
| 11 | No work of the session's own (see below) | `409 OWNED_WORK_PRESENT` (new paths, `changedSinceLaunch`, `unpushed`, `unpushedOnBranches`, `stashes`), or `409 WORK_STATE_UNKNOWN` |
| 12 | The final handoff can be staged | `503 FINALIZE_STAGE_FAILED`; the session stays active |

**Clear to retire.** This uses the same composition that `tc sessions` shows coordinators ([fleet workload](fleet-workload.md)):
- a current `complete` + `safe-to-clear` receipt;
- no control verdict;
- no operator narrowing;
- the engine observed at rest.

A self caller's pane is busy running the request itself, so the observer cannot
see it at rest. For a self caller only, the current receipt of the exact launch
making the request stands in for that one observation. Every other rule still
applies, and the whole composition is checked again at the commit point, so a
receipt that turned stale or `do-not-clear` in the meantime refuses. A delegated
caller needs the observer to read `at-rest`.

**Drained** means no unresolved obligation, read from each exchange's durable
facts rather than from the inbox:
- **Mail sent to the session** must have been acknowledged by the lane, and
  replied to where a reply is required. An acknowledgement made in the
  dashboard is the operator's, not the lane's, and does not count. An exchange
  the lane has acknowledged and answered is resolved even while its initiator
  has not yet closed it.
- **Mail the session sent that requires a reply** must have been answered.
- **Mail it sent that needs no reply** is not an obligation. It may still be in
  flight, and it is counted in the audit.

**Where it works.** The session's pane directory is read first. If the pane is
in a linked worktree of the repository (`git worktree add ...`), its work lives
in a tree the launch baseline never recorded. If the pane's directory cannot be
read, the session might be working anywhere. Either way it cannot be shown to
have left nothing, so the request refuses `WORK_STATE_UNKNOWN`. Only a session
working in the registered checkout is judged further.

**No work of its own.** The remote-tracking refs are refreshed first
(`git fetch --all --prune`); if that fails, the request refuses, because a stale
ref can hold a commit the remote no longer has. Then the checkout is compared
with the session's launch baseline:
- no path changed since launch;
- no path that was already dirty at launch has changed identity since. The
  launch recorded a fingerprint of each such path: its kind, the SHA-256 of its
  bytes or its symlink target, and the executable bit. Finalize compares the
  same fingerprint. A rewrite that restores the exact bytes and mode is not a
  change, whatever its file time. A changed byte, a new symlink target, a mode
  change, a removal or a revert is a change. A launch baseline recorded before
  fingerprints existed cannot be verified and refuses;
- no commit made since launch on HEAD exists that no remote-tracking ref has;
- no commit made since the session started exists on any other local branch
  without a remote-tracking ref, and nothing was stashed since then. Commits on
  a local branch from before the launch are not the session's. These two are
  judged by commit time, because the baseline records only HEAD.

Paths TangleClaw provably owns are judged the way the wrap judges them
(`wrap-steps/_tc-owned-paths`): machine state, and a maintenance change such as
the engine config's generated block rewritten at launch. They are not the
session's work.

If the comparison cannot be made (no baseline, another repository at the path,
`git` failing, a path that cannot be read), the request refuses. Files that were
already dirty at launch belong to someone else, and they are left exactly as
they are.

## What finalizing does

1. **Re-check.** The HOLD/STOP gate, the wrap-run check, the lane composition
   and the Medusa obligations run again, synchronously with the staging and
   the write, so nothing that arrived while the checkout was being read can
   slip in. That includes a message that needs a reply.
2. **Stage the final handoff.** A `tc.handoff/1` `final` document is staged
   through the same code the wrap uses (`handoff-stage#stageAttempt`). It
   records:
   - who retired the session and why;
   - the receipt it was cleared on;
   - the exact branch and head;
   - the worktree facts, the rule manifest and the config hashes the next
     launch checks.

   It carries no next action: none was captured, and inventing one would put a
   fabricated instruction in front of the next session. If staging fails, the
   session stays active and nothing is recorded. An earlier attempt that never
   reached the transition is abandoned first.
3. **Record the end.** The session's row moves `active → wrapped`, and the
   staged attempt is bound eligible in the same transaction. If another path
   ended the session first, the attempt is abandoned and the answer is
   `SESSION_CHANGED`. The one exception is a concurrent finalize of the same
   session: that is the same outcome, and it is reported as such.
4. **Write the summary.** The wrap summary records the facts:
   `Finalized headlessly by project:<id> (<mode>): <reason>`.
5. **Record the audit event.** A `session.finalized` activity event records:
   - `mode`
   - `actor` (principal and session)
   - `reason`
   - `assignmentId`
   - the receipt's `seq`
   - the engine observation (`self-attested` for self)
   - how many paths were dirty at launch and left untouched
   - how many sent messages were still in flight
   - the publication id

   The launch id is never recorded, because it is a bearer credential.
6. **Publish the handoff**, so the next launch's preflight reads `ok` instead of
   a recovery verdict.
7. **Tear down.** This is the same releases `wrap/complete` uses:
   - the Medusa listener and workspace are forgotten, and open inbound exchanges end as `recipient_retired` with each initiator told;
   - the startup channel is released;
   - the tmux pane is killed, unless its name now belongs to a later live
     session of the project (pane names are per project), in which case it is
     left alone;
   - document locks are released.

   Afterwards each resource is read back from its live source, and a
   `session.finalize-teardown` event records each step as `released`, `failed`,
   `already-released`, or for the pane `reassigned`.

The session's end is recorded in one transaction, but publishing and teardown
come after it and can fail or be interrupted. So success is answered only when
the handoff is published and nothing the session held survives. Otherwise the
answer is `409 FINALIZE_INCOMPLETE`, with the `publication` (id, digest, state)
and the `teardown` (steps, surviving). Repeating the same request finishes the
same attempt: it publishes it and releases whatever survives. It never stages
another.

**Who finishes one nobody can repeat.** When a session finalized itself, its
pane is gone, and the operator is not a caller of this route. Two existing
paths finish what is left:
- The next launch's preflight publishes an eligible, unpublished final handoff
  itself, and that launch reads `ok`.
- A pane that outlived its session is an orphan. The operator's kill
  (`DELETE /api/sessions/:project`) removes an orphaned pane when the project
  has no active session.

A coordinator with lifecycle authority can also repeat the request.

It never commits, stages, resets, checks out or discards anything in the
project's git checkout. It opens no drawer. The full wrap pipeline is unchanged
and remains the path for every session that has work to decide.

## The retired pane-text trigger

TangleClaw used to open the wrap drawer when a session printed a fixed marker
into its pane, and the prime told every engine to print it when the user said
"wrap". That trigger is removed (#2027). Pane text is not a trustworthy request
channel: anything that can print into a pane can print a marker, whether that is
the engine quoting documentation, a tool's output or a relayed message. The
drawer opens only from the explicit Wrap button, and the headless path is the
authenticated request above.
