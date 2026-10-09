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

## Who may rotate

Only a project the operator has granted a **coordinator role** may prepare a rotation:
`POST /api/coordinator-roles {projectId, role: "architect" | "project-manager", note?}`.
- **One active role per project.** Granting again replaces the active role and bumps its
  **authority version**.
- **Revoking:** `POST /api/coordinator-roles/revoke {projectId}` ends it.
- **Listing:** `GET /api/coordinator-roles`.
- All three are operator-only. The `role` named in a checkpoint is not authority.

A rotation records the role and authority version it was prepared under. If either changes while the
rotation is open, that is **authority drift**. No receipt can accept it, and only the operator can
recover the rotation.

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
| `abandoned` | operator | The rotation could not finish, or the operator released an active rotation's epoch (for example after the coordinator was relaunched without a rotation). The fence and the binding are lifted; the channel is left as it stands. |

A step that cannot proceed does not change the state. It records a typed `failure` on the rotation
and the next pass retries it, so a retry always continues the same attempt. Nothing mints a second
authority. The database allows one open rotation per project, enforced by a partial unique index.

## Clear in place or relaunch

`prepare` takes `mode`: `clear` (the default) or `relaunch`.

- **`clear`.** The server types `/clear` into the running session once its turn ends, then binds the
  replacement thread the clear produced. This is described below.
- **`relaunch`.** The coordinator ends its whole session instead: a wrap, or the operator ending it.
  The rotation types nothing into the pane.
  - **While it is `fenced`.** The fence persists across the session's end. The ending session may
    still wrap itself, from its own thread and launch. That is the only action allowed.
  - **Claim.** Once the old session's own record shows it ended (`wrapped`, `killed` or
    `crashed`), the operator makes the **relaunch claim**. A missing or unreadable record is not proof,
    so the claim is refused with `ROTATION_PRIOR_SESSION_NOT_ENDED` and the rotation stays fenced. The
    call is:
    `POST /api/tc/rotation/relaunch {rotationId}`. The server launches the successor session and, in
    one compare-and-set, binds the rotation to exactly that new session, launch and control channel.
  - **Rebind.** The replacement is the thread the successor's own channel records. It is never
    inferred from a thread that has merely become visible. Until the channel records one, the rotation
    waits with `successor-thread-unrecorded`. The re-entry turn tells the successor to finish its own
    launch sequence first.
  - **Unclaimed launches.** A launch the claim did not make, such as an ordinary launch from the
    dashboard, is never bound. It stays fenced, and it must end before the claim can run.
  - **Unbindable successor.** A successor with no rebindable channel is not claimed. It is recorded as
    `relaunch-unbindable`, and the next command is the operator's abandon.

## Pacing the clear

`/clear` is typed at a bounded pace:
- **Only admitted attempts count.** An attempt counts toward the limit of three only when the pane
  admitted it. A HOLD, a missing pane or any other refusal is recorded as `clear-refused` and not
  counted.
- **Retry spacing.** A refused attempt is retried no sooner than 15 seconds later.
- **Settle window.** After an admitted clear, the old thread gets 20 seconds to unload
  (`clear-settling`). No second `/clear` is typed over it inside that window.
- **Rebind settle window.** Real Codex keeps the old thread loaded for a few seconds after `/clear`,
  beside the new one. It also opens a short-lived auxiliary thread beside a thread's first turn. For 2
  minutes after an admitted clear, both are waits (`prior-thread-unloading`, `replacement-settling`)
  whose next command is `tc rotation advance`. Only if either persists past the window does it become
  `prior-thread-still-loaded` or `replacement-ambiguous`, which need the operator. The window never
  binds a thread by guessing: it waits for exactly one candidate.
- **One pass at a time.** Passes over one rotation are serialized in the server, so two passes can
  never type twice or send two re-entry turns.
- **Recorded failures.** A pass that throws leaves `driver-error` on the rotation.

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

## The fence and the epoch

Once a project has rotated, its coordinator-authority mutations are judged by the **epoch gate**
(`lib/coordinator-rotation.js#gate`). The gated mutations are:
- Medusa send (replies included), acknowledge (`/read`) and exchange close;
- Medusa loops: opening one, and continuing, force-closing or closing one out;
- the Medusa listener toggle;
- typing into the coordinator's pane (`POST /api/sessions/:project/command`) and firing its startup
  prompt;
- `tc workload set`;
- session-rule writes;
- control create, hold, release, stop, close and ack;
- starting, completing or handing back a wrap (which is where a handoff is published and the session
  finalized).

| Latest rotation | What the gate allows |
|---|---|
| none, or `abandoned` | Everything, as before: the project is not judged. |
| `fenced` or `rebinding` | Nothing: no replacement is bound yet. Refused with `409 COORDINATOR_FENCED`. |
| `reconciling` | Only from the bound replacement: `tc workload set`, the control ack, turning the listener **on** (`enabled: true`; turning it off waits), and replies to, acks of, or closes of the messages and exchanges the checkpoint recorded. Anything else, loops and typed commands included, is `COORDINATOR_FENCED`. |
| `active` | Everything, but only from the bound replacement. |

"The bound replacement" is one exact combination: the replacement thread, the session and the launch
the rotation bound. `tc` forwards the thread automatically: it reads the `CODEX_THREAD_ID` that Codex
sets in every tool shell and sends it as `x-tangleclaw-engine-thread`.
- **Nothing to carry.** No secret rides in argv, shell history or an environment the model manages.
- **Refused callers.** A stale thread, another pane, or a caller with no launch binding is refused
  with `409 COORDINATOR_EPOCH_MISMATCH`. A subagent's own thread is refused too, but only when its call
  goes through `tc`, which forwards the thread the call really runs in (see the next bullet).
- **How long it binds.** The binding holds while the bound session lives, until a governed next
  rotation replaces it or the operator releases it with abandon.
  - **When the bound session ends.** A wrap or a kill ends the session, and with it the epoch: no
    context of that epoch can act any more. The epoch lapses only on persisted evidence: the bound
    session's row must record `wrapped`, `killed` or `crashed`. A missing or unreadable row is
    uncertainty, and uncertainty keeps the fence. No successor inherits the old epoch. The coordinator's next ordinary launch is then judged as
    if it had never rotated, and needs no operator.
  - **How it is recorded.** A completed rotation stays `active` in the record. A lapse is never
    recorded as `abandoned`.
- **Use `tc`, not raw HTTP.** `tc` is what sends the thread header. A bound coordinator must make
  every call through it (`tc message read|ack|send|close`, `tc control`, `tc workload`), because a raw
  HTTP call carries no header and is refused.
- **The operator.** A verified operator is never gated. Verified means control's own proof: a
  signed-in operator, or an install whose auth gate is deliberately open. A request that only looks
  like the operator is judged as an unbound caller.
- **What the thread header is, and is not.** `x-tangleclaw-engine-thread` is attribution: the server
  compares it with the thread the rotation bound. It is not authentication. Anything that can run in
  the coordinator's launch environment can send the same header, including a subagent that shares
  that environment, so such a process is not cryptographically excluded. The binding keeps a stale
  or other context from acting by mistake. The launch binding and the operator's controls remain the
  security boundary.

The Medusa wake also holds while a rotation is open. Its skip reason is `coordinator-rotating`. Once
the rotation is active, a newer inbox edge is nudged once, like any other.

## The resume nonce

The re-entry turn carries a **one-time resume nonce**. It is minted only when the turn is actually
sent, and the server stores only its hash. The replacement puts the nonce in its receipt file as
`resumeNonce`, and `tc rotation resume` sends it beside the receipt, never inside it. Resume needs
the nonce and the bound thread. An accepted resume spends the nonce.

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
  "branch": { "head": "<sha>", "ref": "main", "ownedDirt": ["lib/x.js"], "importantIgnored": [".env"] },
  "nextActions": ["…"],
  "note": "where it ended",
  "github": [{ "repo": "owner/name", "kind": "pr", "number": 1966, "state": "open", "headSha": "<sha>", "merged": false }]
}
```

- **Checkout.** At prepare the server fingerprints the project checkout and the checkpoint must agree
  with it:
  - `head` and `ref` must be the checkout's own values;
  - `ownedDirt` must name every changed or untracked path, and a checkout with undeclared dirt is
    refused;
  - every `importantIgnored` file must exist and be ignored.

  The fingerprint hashes the whole tracked diff against HEAD, every untracked file (directories are
  expanded) and each declared important ignored file. It never reads an ignored dependency or build
  cache.
- **GitHub.** `github` lists each issue or PR the coordinator's plan depends on, or `[]` when there
  are none, up to 100 facts. At prepare the server reads each one itself through `gh`, using
  `lib/github-facts.js`. A fact it cannot read, or one the checkpoint declares wrongly, refuses the
  prepare.
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
  "resumeNonce": "<from the re-entry instruction>",
  "drift": [{ "key": "github:owner/name#pr1966", "disposition": "accepted", "note": "merged while away" }],
  "reconciled": {
    "control": { "stateGeneration": 3 },
    "medusa": { "handled": ["<message ids>"] }
  },
  "nextAction": "the next safe dispatch decision"
}
```

Before it looks at the receipt, the server re-observes what must not change while a coordinator is
absent: the coordinator role, and the checkout's content fingerprint. Either kind of difference is
**integrity drift**. It is stored on the rotation as typed items with before and after digests, and
the resume is refused with `409 ROTATION_OPERATOR_RECOVERY_REQUIRED`. No acknowledgement in the
receipt accepts integrity drift. Checkpoint and receipt files belong **outside** the checkout, for
example in `$TMPDIR`; `tc` refuses a path inside it. For a relaunch, the baseline is taken again at
the claim, after the old session's wrap and the successor's launch, because both legitimately change
the checkout. What changed before the claim is kept as an observation (`drift.relaunch`). The
replacement must therefore not commit or edit its checkout
before it resumes. A checkout that cannot be observed is refused with
`409 ROTATION_EVIDENCE_UNAVAILABLE`.

The server then re-reads the checkpoint's GitHub facts. This is **trusted drift**: GitHub may
legitimately change while a coordinator is away, for example when a PR merges.
- **Stored.** Each changed fact is stored with a stable key and before and after digests, next to the
  observation itself.
- **Disposed of by the receipt.** Every changed fact must appear in `receipt.drift` with a disposition
  (`accepted`, `superseded` or `follow-up`), and the receipt's `nextAction` must be updated. An
  undisposed item is refused with `409 ROTATION_DRIFT_UNACKNOWLEDGED`, naming the keys.
- **Unreadable.** A fact that can't be read is `ROTATION_EVIDENCE_UNAVAILABLE`.

Observations and dispositions are persisted on the rotation whether the resume is accepted or not.

After that, the server accepts the receipt only when every check it can make itself agrees. The
checks are:

- the digest matches the recorded checkpoint;
- none of the prepare-time inbox messages are still unhandled (mail that arrived later stays queued
  and does not block). A Medusa listener is required when the project has the switchboard enabled
  (`medusaEnabled`; an unreadable config counts as enabled) or when the prepare recorded messages.
  Prepare also refuses a switchboard coordinator whose listener is down
  (`409 ROTATION_LISTENER_DOWN`). Only a coordinator that runs without the switchboard, with nothing
  recorded, is not held for a listener;
- `control.stateGeneration` is the lane's current control generation, or `null` when there is no
  assignment;
- for a relaunch, the successor's own launch sequence has been attested READY. Until then the
  successor holds no coordinator authority;
- the **readiness verdict** (ruling A8): the replacement's newest `tc workload set` receipt was
  published after the re-entry turn, is still current, and says `working` or `waiting-external` with
  `do-not-clear`. The verdict is persisted on the rotation either way.

A refusal is `409 ROTATION_EVIDENCE_MISSING`. It lists each failed fact under `missing`, and the
fence stays up. A receipt of the wrong shape is `400 ROTATION_RECEIPT_INCOMPLETE`. A receipt for
another attempt or generation is `409 ROTATION_STALE_GENERATION`.

## The operator surface

`GET /api/rotations` (operator only) lists the recent rotations. `tc rotation show` gives a
coordinator its own rotation, and `tc sessions` (`GET /api/tc/sessions`) adds a `rotation` block to
every lane that is rotating. Each of them shows:
- the state and mode;
- the checkpoint digest;
- the **binding**: session, thread and generation. It never includes the launch id or the nonce;
- the receipt verdict (`accepted`, or the persisted readiness verdict);
- the **blocker** in words;
- **exactly one next command** for whoever holds the rotation. That is `tc rotation advance` while
  the server is still working, `tc rotation resume --receipt <file>` while reconciling, the relaunch
  claim for a fenced relaunch, or the operator's abandon when integrity drift or a failure the driver
  cannot get past is in the way.

A dashboard view is deferred under the operator UI freeze (ruling A24).

## Live-Codex integration check

The unit tests run against a fake app-server. Before merge, an independent executor runs
`scripts/rotation-live-check.js` inside a real Codex coordinator pane, at the exact head under
review. The coordinator's shell runs the three phases:
- **`pre`** checks that `CODEX_THREAD_ID` is exported and equals the thread the control channel
  records. `GET /api/tc/rotation` reports both under `binding`.
- **`prepare <checkpoint.json>`** starts a managed clear. End the turn afterwards.
- **`post`**, run in the replacement context, checks four things: this is a different thread, the
  rotation bound exactly it, the channel records it, and the bound replacement may publish workload
  while reconciling.

Each phase prints `PASS` or `FAIL` lines and exits non-zero on any failure.

## Commands and routes

Prepare, show, advance and resume are bound to the caller's own verified launch; relaunch, abandon, `GET /api/rotations` and the coordinator-role routes are the operator's alone. An unbound, forged or
foreign caller is refused with `403 ROTATION_BINDING_REQUIRED`. On a write, a caller with no launch
binding or one that does not verify is refused earlier, with `403 LAUNCH_BINDING_REQUIRED` or
`LAUNCH_BINDING_INVALID`: see "Who may write" in `docs/configuration-reference.md`.

| Command | Route | Purpose |
|---|---|---|
| `tc rotation prepare --checkpoint <file> [--key <k>]` | `POST /api/tc/rotation/prepare` | Begin a rotation and start the server's driver. The default attempt key comes from the checkpoint's content, so re-running the same prepare converges on the same rotation. |
| `tc rotation show` | `GET /api/tc/rotation` | The open rotation, with its checkpoint, inbox interval and receipt template. |
| `tc rotation advance` | `POST /api/tc/rotation/advance` | Retry the server's side after fixing what blocked it. |
| `tc rotation resume --receipt <file>` | `POST /api/tc/rotation/resume` | Submit the receipt. `tc` fills in the rotation id, attempt key and generation from the server. |
| — | `POST /api/tc/rotation/relaunch` `{rotationId}` | The operator's relaunch claim: launch the successor and bind exactly it. |
| — | `GET /api/rotations` | The operator's read surface. |
| — | `POST /api/tc/rotation/abandon` `{rotationId, reason}` | The operator ends a rotation that cannot finish. |

After a restart, the server resumes the driver for every rotation still `fenced` or `rebinding`.

## Engines

A managed rotation needs a startup-control channel that can name and rebind threads, which today
means Codex. For any other engine, prepare is refused with `409 ROTATION_ENGINE_UNSUPPORTED` and the
reason. Claude keeps its own re-entry path: the SessionStart hook's re-entry preamble (#1761) after
`/clear`.

## Known limits

- **Codex only.** The engine thread comes from Codex's `CODEX_THREAD_ID`. The source was inspected;
  a live Codex-pane integration check is still an open acceptance item.
- **No dashboard view.** It is deferred under the operator UI freeze. The API and `tc` read surfaces
  are the emergency operator surface.

Implementation: `lib/coordinator-rotation.js`, `lib/startup-control-codex.js` (`rotationThreads`,
`rebindThread`, `deliverTurn`) and the `coordinator_rotations` and `coordinator_roles` tables (schema v51). Tests:
`test/coordinator-rotation.test.js`, `test/api-coordinator-rotation.test.js` and
`test/tc-rotation-verb.test.js` and `test/checkout-fingerprint.test.js`. The checkout fingerprint is
`lib/checkout-fingerprint.js`.
