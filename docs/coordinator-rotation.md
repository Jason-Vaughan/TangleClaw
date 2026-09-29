# Coordinator context rotation

A coordinator session (an Architect or ProjectManager) sometimes has to drop its context mid-session.
It clears to shed a long transcript, or relaunches after a wrap. Before #2032, a Codex coordinator
that was `/clear`ed came back live but unoriented:

- Its startup-control channel stayed bound to the thread that no longer existed.
- Every Medusa wake answered `engine-thread-unknown` (the adapter's `thread-not-loaded`), so no mail
  woke it.
- Nothing stopped it dispatching again before it had checked what changed.

A **managed rotation** makes the clear an explicit, recorded transition. The coordinator writes a
structured checkpoint, and TangleClaw then:

- fences the coordinator's new dispatch;
- clears the coordinator;
- binds the one replacement thread it can prove;
- tells that thread how to re-enter.

The fence lifts only when the replacement context submits a receipt that the server has checked
against what it can see.

Ordinary wake observation is unchanged: it still never replaces a recorded thread. Only an open
rotation may, and only to the replacement it proved.

## States

```
fenced → rebinding → reconciling → active
   └──────────┴───────────┴──→ abandoned   (operator only)
```

| State | Who acts | What happens |
|---|---|---|
| `fenced` | server | Waits for the coordinator's current turn to end, records the threads loaded at that moment, and types `/clear`. |
| `rebinding` | server | Finds the replacement, binds it to the channel under the new generation, and delivers the re-entry turn. |
| `reconciling` | replacement context | Reads the checkpoint back, reconciles it against live state, handles the recorded inbox interval, and submits the receipt. |
| `active` | — | The receipt was accepted and the fence is lifted. This generation is now the project's current coordinator generation. |
| `abandoned` | operator | The rotation could not finish. The fence is lifted and the channel is left as it stands. |

A step that cannot proceed does not change the state. It records a typed `failure` on the rotation
and the next pass retries it, so a retry always continues the same attempt. Nothing mints a second
authority. The database allows one open rotation per project, enforced by a partial unique index.

## The replacement thread

After `/clear`, the replacement is the **one** root thread in the project directory that was not
loaded when the clear was typed. The prior thread must be gone. Every other outcome binds nothing:

| Seen after the clear | Failure code |
|---|---|
| Nothing new, prior thread still loaded and idle | `/clear` is typed again, up to 3 times, then `clear-not-applied` |
| A new thread, prior thread still loaded | `prior-thread-still-loaded` |
| No new thread | `replacement-not-loaded` |
| Two or more new threads | `replacement-ambiguous` |
| A different channel, sequence or session | `channel-changed` |
| The coordinator's turn is still running | `prior-thread-busy` |

A new subagent, a thread in another directory and a thread already loaded before the clear are never
candidates.

The rebind is a compare-and-set on the channel row: the row must still be open, on the same launch
sequence, with the recorded thread still the prior one. It lives in
`lib/startup-control-codex.js#rebindThread`, which is the only code allowed to move a recorded
thread.

The re-entry turn carries a digest of the rotation and generation as its client id. It is read back
from the thread before it is ever sent again, so a crash after sending never produces a duplicate.

## The fence

While a project has an open rotation:

- **Medusa `send` from the project** is refused with `409 COORDINATOR_FENCED`, unless it is a reply
  (`inReplyTo`). The replacement may need to answer a verification question while it reconciles.
- **The Medusa wake** does not nudge the session. Its skip reason is `coordinator-rotating`. Mail
  keeps arriving and queues. Once the rotation is active, a newer inbox edge is nudged once, like any
  other.

Workers are not stopped. The fence holds only the coordinator's new boundary-crossing dispatch.

## Checkpoint (schema 1)

Every section must be present, even when it is empty, so a missing section reads as a gap rather
than as "nothing there":

```json
{
  "schema": 1,
  "role": "architect",
  "assignments": [{ "lane": "RM01", "issue": 2027, "head": "<sha>" }],
  "decisions": [{ "id": "A1", "state": "open" }],
  "exchanges": [{ "id": "mx_…", "with": "tangleclaw-projectmanager" }],
  "branch": { "head": "<sha>", "status": "clean" },
  "nextActions": ["…"],
  "note": "where it ended"
}
```

- **Digest:** the server takes the SHA-256 of the canonical JSON (keys sorted), so key order does not
  matter.
- **Size:** the checkpoint may be at most 60,000 bytes.
- **Inbox interval:** the prepare records the ids of the messages in the inbox at that moment, up to
  300. This is the interval the replacement must handle.

## Receipt (schema 1)

`tc rotation show` prints this template with the checkpoint digest already filled in:

```json
{
  "schema": 1,
  "checkpointDigest": "<from show>",
  "restored": ["each checkpoint fact confirmed"],
  "drift": ["each fact that had changed, and how"],
  "reconciled": {
    "git": { "head": "<git rev-parse HEAD>" },
    "github": { "checkedAt": "<ISO time>" },
    "control": { "stateGeneration": 3 },
    "medusa": { "handled": ["<message ids>"] }
  },
  "nextAction": "the next safe dispatch decision"
}
```

The server accepts the receipt only when every check it can make itself agrees. The checks are:

- the digest matches the recorded checkpoint;
- none of the prepare-time inbox messages are still unhandled (mail that arrived later stays queued
  and does not block);
- `git.head` is the checkout's actual HEAD;
- `control.stateGeneration` is the lane's current control generation, or `null` when there is no
  assignment;
- the launch has published a workload receipt since the rotation began.

A refusal is `409 ROTATION_EVIDENCE_MISSING`. It lists each failed fact under `missing`, and the
fence stays up. A receipt of the wrong shape is `400 ROTATION_RECEIPT_INCOMPLETE`. A receipt for
another attempt or generation is `409 ROTATION_STALE_GENERATION`.

## Commands and routes

Every route except abandon is bound to the caller's own verified launch. An unbound, forged or
foreign caller is refused with `403 ROTATION_BINDING_REQUIRED`.

| Command | Route | Purpose |
|---|---|---|
| `tc rotation prepare --checkpoint <file> [--key <k>]` | `POST /api/tc/rotation/prepare` | Begin a rotation and start the server's driver. The default attempt key comes from the checkpoint's content, so re-running the same prepare converges on the same rotation. |
| `tc rotation show` | `GET /api/tc/rotation` | The open rotation, with its checkpoint, inbox interval and receipt template. |
| `tc rotation advance` | `POST /api/tc/rotation/advance` | Retry the server's side after fixing what blocked it. |
| `tc rotation resume --receipt <file>` | `POST /api/tc/rotation/resume` | Submit the receipt. `tc` fills in the rotation id, attempt key and generation from the server. |
| — | `POST /api/tc/rotation/abandon` `{rotationId, reason}` | The operator ends a rotation that cannot finish. |

After a restart, the server resumes the driver for every rotation still `fenced` or `rebinding`.

## Engines

A managed rotation needs a startup-control channel that can name and rebind threads, which today
means Codex. For any other engine, prepare is refused with `409 ROTATION_ENGINE_UNSUPPORTED` and the
reason. Claude keeps its own re-entry path: the SessionStart hook's re-entry preamble (#1761) after
`/clear`.

## Known limits

- **Old and new contexts share one pane and one launch.** Once the old context is cleared it no
  longer exists, and the server cannot tell a request replayed from it apart from the replacement's
  own. Generation is therefore enforced on the calls that carry it (resume, and through it the fence
  release). Marking mail handled and closing an exchange are not generation-bound.
- **GitHub is asserted, not checked.** The receipt carries `github.checkedAt`, but the server does
  not query GitHub itself.
- **Full wrap-and-relaunch parity, and a dashboard view of rotation state, are not built yet.** They
  are #2032's E4 slice.

Implementation: `lib/coordinator-rotation.js`, `lib/startup-control-codex.js` (`rotationThreads`,
`rebindThread`, `deliverTurn`) and the `coordinator_rotations` table (schema v51). Tests:
`test/coordinator-rotation.test.js`, `test/api-coordinator-rotation.test.js` and
`test/tc-rotation-verb.test.js`.
