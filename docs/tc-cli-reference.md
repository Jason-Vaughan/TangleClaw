# `tc` Command Reference

`tc` is the command a session uses to talk to TangleClaw from inside its own terminal: who it is, what the rest of the fleet is doing, its mail, its launch context, and the state it reports.

**Applies to:** TangleClaw 5.34.0. Other versions may have a different roster; on any install, `tc --help` is the authority.

**If this page and your install disagree, your install is right.** `tc --help` prints the roster of the version you are running. Stop and use its help and error output until this page is corrected.

## Fast help

```bash
tc --help
```

`tc --help` prints the roster and exits 0. `tc` with no verb prints the same roster as a usage error and exits 1.

`tc --help`, and `tc` with no verb, answer before reading the environment, so they work anywhere. Every verb depends on the identity and API variables TangleClaw exports into every session it launches (`TANGLECLAW_API`, `TANGLECLAW_PROJECT_ID`, `TANGLECLAW_LAUNCH_ID` and others), and `tc` deliberately does not guess those values when run outside a session TangleClaw launched. It is normally on `PATH` in a launched pane.

## Command families at a glance

This page lists every top-level verb `tc --help` shows, including the restricted ones. The tables below say what each command does. `queue` and `check` are left out of the verb list a launched session is primed with, and so is `candidate` unless the operator has the bridge on and has told every session about candidates; `tc --help` lists all three either way.

| Family | Purpose |
| --- | --- |
| `whoami`, `capabilities` | Identify this session and its permitted capabilities. |
| `sessions`, `freshness` | Inspect the fleet and its checkout or launch-isolation state. |
| `message` | Exchange and account for switchboard messages. |
| `control` | Inspect or, with authority, change durable HOLD/STOP state. |
| `start` | Read and attest launch context; re-read it after a clear. |
| `workload` | Report this session's work and clearance state. |
| `rotation`, `finalize` | Govern coordinator context rotation and session retirement. |
| `branch` | Check whether a branch can be retired safely. |
| `queue`, `check` | Use the merge queue, and watch a named check on an exact commit. |
| `candidate` | Submit a verified notice candidate to the Project Master. |
| `bridge` | Let the authorized Project Master route operator messages and decide notice candidates. |
| `ports`, `docs`, `rules`, `learnings` | Discover leases and project context. |

## The launch commands most people need

| Situation | Command | Meaning |
| --- | --- | --- |
| A newly launched session has not completed onboarding | `tc start next` | Read the next launch step. Follow the acknowledgement command printed by each step, then complete the READY attestation printed by the sequence. |
| A launch step has multiple pages | `tc start next --page <n>` | Read a specific zero-based page of the current step before acknowledging it. |
| Check whether launch onboarding is complete | `tc start status` | Show the launch cursor, acknowledgements and READY state. |
| The same already-attested session was `/clear`ed or compacted | `tc start review` | Re-read the frozen launch context without starting or changing onboarding. This refuses when the launch has not yet been attested. |
| A managed coordinator rotation is resuming | `tc rotation show`, then `tc rotation resume --receipt <file>` | Reconcile the prior checkpoint and lift the dispatch fence with a checked receipt. This is separate from ordinary session launch onboarding. |

The important distinction is: **new or unattested launch = `tc start next`; already-attested session after `/clear` or compaction = `tc start review`.**

## Identity and discovery

| Command | What it does |
| --- | --- |
| `tc whoami` | Shows this pane's resolved project/session identity, TangleClaw location and available capabilities. |
| `tc capabilities` | Lists enabled and disabled capabilities and the reason for each state. |
| `tc sessions` | Lists every live TangleClaw session visible across projects, with its composed workload state. |
| `tc sessions isolation` | Shows whether each live session was started independently of its engine's shared background process, or whether that cannot be proved. |
| `tc sessions isolation --replaced <session-id,…>` | Checks whether named older sessions were ended and their projects relaunched with isolation. The IDs are comma-separated. |
| `tc freshness` | Shows the commit of each visible live checkout and its relationship to `origin/main`. |
| `tc ports` | Shows PortHub leases. Check this before binding a port. |
| `tc docs` | Lists shared documents available through this pane's project groups, with this project's notice setting for each. The other `tc docs` forms are under [Shared documents](#shared-documents). |
| `tc rules` | Lists this project's durable session rules and their review state. |
| `tc learnings` | Lists the project's recorded cross-session learnings. |

## Switchboard messaging

| Command | What it does |
| --- | --- |
| `tc message send <workspace-id> <text...>` | Sends a normal message to an exact workspace ID. |
| `tc message send --priority blocking --reason <code> --reply-required <workspace-id> <text...>` | Opens a blocking, reply-required exchange. Optional send flags also include `--in-reply-to <message-id>`, `--no-reply`, `--escalate-after <minutes>` and `--request-id <id>`. |
| `tc message read` | Reads this session's inbox and verifies that its listener is actually listening before claiming an empty inbox. |
| `tc message ack <message-id> [<message-id>...]` | Marks received messages handled. This does not replace closing an exchange that you initiated. |
| `tc message status <workspace-id>` | Shows whether a peer is reachable and why a message may not have been picked up. |
| `tc message sent` | Lists open exchanges initiated by this session. |
| `tc message owed` | Lists this session's outstanding replies first, then messages it has not handled. |
| `tc message close <exchange-id>` | Closes an exchange initiated by this session after its reply has arrived. |

`--priority` is `normal` or `blocking`. Use exact workspace IDs, not a display name. Reply with `--in-reply-to <message-id>` before acknowledging a message that requires an answer. The initiator owns closing a reply-required exchange.

## Shared documents

Background: [shared-document revisions and notices](medusa-delivery.md#shared-document-revisions-and-notices).

| Command | What it does |
| --- | --- |
| `tc docs` | Lists the shared documents in the groups this pane may read, with this project's notice setting for each. |
| `tc docs base <doc>` | Has the server observe the document and prints the digest to save before an edit. Nothing is attested yet. |
| `tc docs attest <doc> --base <saved-digest>` | Attests the edit made from the saved base. The digest must be the one `tc docs base` printed before the edit. |
| `tc docs mute\|unmute\|subscribe\|default <doc>` | Sets this project's notice setting for one document. `unmute` clears it, as `default` does. |
| `tc docs mute\|unmute\|subscribe\|default --group <group>` | Sets the same for a whole group. A document's own setting overrides its group's. |

`<doc>` is a document's id or name, and `<group>` a group's id or name. Take the document's lock before `base` and release it after `attest`. Attested authorship records that the lock holder named its base; it is not proof of who wrote the bytes.

## Merge queue

Background: [the merge queue](merge-queue.md).

| Command | What it does |
| --- | --- |
| `tc queue status` | Shows each queue's entries in order, each entry's state and each gate, and whose word each one is. |
| `tc queue show <entry>` | Shows one entry. |
| `tc queue submit <pr> --head <sha> --review <ref> --test <ref> --base <ref> [--operator-gate required\|none] [--queue <id>]` | As the queue's owner project, submits a pull request at an exact head with its review, test and base gates. `--operator-gate` is `none` unless given. |
| `tc queue withdraw <entry> --reason <text>` | As the owner project, withdraws an entry. |
| `tc queue advance [--queue <id>]` | As the owner project, moves the front entry one step: makes its candidate, or lands it once every gate holds. |

A submit, withdrawal or advance that got no answer in time may still be running, or may have finished: `tc` says so and exits 2. Read `tc queue status` before repeating it.

## Check watches

Background: [check watches](check-watch.md).

| Command | What it does |
| --- | --- |
| `tc check watch <pr> --sha <sha> --name <check> --due <minutes>` | Registers a watch, for this session's own project, on a named check of an exact commit of a pull request. `--due` is a whole number of minutes from now. Prints the new watch's id. |
| `tc check list [--project <id>]` | Lists this project's watches, or those of a project that shares a group with it. |
| `tc check show <watch>` | Shows one watch: its state, the last read of GitHub, what became of each message and its history. |
| `tc check cancel <watch>` | Cancels a watch of this project. |

The state is `waiting`, `ready`, `failed` or `unknown`, derived from what the server has recorded each time it is read. A refusal exits 2 with the server's code and words; a malformed command exits 1 before any request.

## Operator notification candidates

| Command | What it does |
| --- | --- |
| `tc candidate submit --kind <milestone\|operator-action-required> --receipt workload:<seq> --text "<text>"` | Offers a milestone or operator action to the Project Master, backed by this session's workload receipt. It posts nothing to the operator by itself. |

Get `<seq>` from `tc workload show`. Repeat `--receipt workload:<seq>` to cite more of this session's receipts. `--text-file <file>` can replace `--text`; `--request-id <id>` makes an uncertain submission safe to retry. The Project Master reviews, merges, rejects or approves the candidate.

## Operator bridge (Project Master only)

These commands require the live Project Master's bridge credential. The bridge itself is described in [the operator bridge guide](operator-bridge.md). A project session uses `tc candidate submit` for a notice and `tc message` for a peer; it does not route or post through `tc bridge`. Read a route or candidate to get its current version before changing it. Bridge writes take `--request-id <id>` for safe retries; route and candidate decisions also take `--version <n>` unless a row states otherwise.

| Command | What it does |
| --- | --- |
| `tc bridge status` | Shows whether the bridge is enabled and its current state. |
| `tc bridge destinations` | Lists reachable project destinations and whether they are running. |
| `tc bridge nicknames` | Lists saved destination nicknames. |
| `tc bridge nickname <name>` | Explains one nickname, its target and provenance. |
| `tc bridge nickname set <name> --to <dest> --answered-by <route-id>` | Saves a nickname requested by the operator. |
| `tc bridge nickname rename <name> <new-name> --answered-by <route-id>` | Renames a nickname without changing its target. |
| `tc bridge nickname forget <name> --answered-by <route-id>` | Removes a nickname. |
| `tc bridge routes [--state <state>]` | Lists routes, oldest first, without their message bodies. |
| `tc bridge read <route-id>` | Reads one route, its held text, state and version. |
| `tc bridge route <route-id> --version <n> --to <dest>` | Sends a held message to the chosen destination. `--answered-by <route-id>` adopts a correlated operator reply when required. |
| `tc bridge ask <route-id> --version <n> --text "<question>"` | Asks the operator a clarification while keeping the original message held. |
| `tc bridge ask-launch <route-id> --version <n> --project <project>` | Asks whether to launch a stopped project's session; does not launch it. |
| `tc bridge launch <route-id> --version <n> --answered-by <route-id>` | Records the correlated operator consent, then has the server launch the session and deliver the held message when ready. |
| `tc bridge decline <route-id> --version <n> --answered-by <route-id>` | Closes a held message on the operator's no or cancel without launching or delivering it. |
| `tc bridge answer <route-id> --version <n> --text "<text>"` | Sends the Master's answer to the operator. |
| `tc bridge release <route-id> --version <n>` | Releases an unchanged operator reply that the gateway is holding. |
| `tc bridge pin <route-id> --version <n> --to <dest>` | Pins the conversation's destination. |
| `tc bridge close <route-id> --version <n>` | Closes a route, clears its text and withdraws any unposted item for it. |
| `tc bridge candidates` | Lists submitted notice candidates waiting for a decision. |
| `tc bridge candidate <candidate-id>` | Reads a candidate, its text, receipts and version. |
| `tc bridge approve <candidate-id> --version <n>` | Rechecks its receipts and releases a verified notice to the operator; optional `--text` or `--text-file` supplies the Master's wording. |
| `tc bridge reject <candidate-id> --version <n>` | Rejects a candidate; nothing is posted. |
| `tc bridge merge <candidate-id> --version <n> --into <candidate-id>` | Folds a duplicate candidate and its receipts into another candidate. |
| `tc bridge blocked` | Lists outbound items the helper could not post. |
| `tc bridge requeue <item-id>` | Returns a set-aside item to the helper's mailbox. |
| `tc bridge withdraw <item-id>` | Permanently withdraws an item that has not been posted. |
| `tc bridge circuit ack <episode>` | Acknowledges an open bridge configuration episode; it remains open. |
| `tc bridge reset --requeue` or `tc bridge reset --withdraw` | Closes the configuration episode and either retries or withdraws its set-aside items. |

`<dest>` is `master` or a reachable project's ID, name, slug or nickname. `tc bridge destinations` shows the valid values. `tc bridge ask` and `answer` accept `--text-file <file>` in place of `--text`.

## Durable control state

Background: [control state](control-state.md).

| Command | What it does |
| --- | --- |
| `tc control status` | Shows whether this lane is governed by an assignment, HOLD or STOP, including its generation. |
| `tc control ack <generation>` | Acknowledges the HOLD or STOP generation shown by `status`. It does not lift the control. |
| `tc control hold <assignment-id> <reason-code>` | With lifecycle authority, places a durable hold on an assignment. |
| `tc control release <assignment-id> <expected-generation> <reason-code> <hold-id...>` | With authority, releases named holds using the generation just observed. |
| `tc control stop <assignment-id> <reason-code>` | With authority, permanently stops the assignment. A new assignment is required to work again. |

## Launch onboarding and re-entry

| Command | What it does |
| --- | --- |
| `tc start next` | Serves the next unacknowledged step of a new launch sequence. |
| `tc start next --page <n>` | Serves a zero-based page of the current step. |
| `tc start next --ack <step>:<revision>:<digest>` | Acknowledges the exact step/revision/digest printed by the server and advances the sequence. |
| `tc start status` | Shows the current launch sequence and READY state. |
| `tc start ready --verdict <preflight-verdict> --first-action <text>` | Attests the launch READY after every step is acknowledged. Add `--reconciliation <text>` when the launch requires it. Use the exact values/instructions printed by the sequence. |
| `tc start review [--step <n\|id>] [--page <n>]` | Read-only re-read of the frozen context for an already-attested launch after `/clear` or compaction. It never advances or re-attests the launch. |

Do not use `tc start review` as a shortcut for a fresh launch. A `NOT_READY` refusal means the correct path is `tc start next` through all steps, followed by the printed READY command.

## Workload receipts

Background: [fleet workload](fleet-workload.md).

| Command | What it does |
| --- | --- |
| `tc workload show` | Shows this launch's latest workload receipt and the composed availability/clearance verdict coordinators see. |
| `tc workload set <state> --clearance <clearance> --summary "<one line>"` | Records the lane's current work and clearability. States: `working`, `waiting-external`, `blocked`, `complete`. Clearances: `safe-to-clear`, `do-not-clear`, `unknown`. |

Optional `workload set` metadata:

```text
--wait <ci|review|operator|peer|merge|other>
--wait-detail "<text>"
--issue <n>        # repeatable
--pr <n>           # repeatable
--task <id>        # repeatable
--branch <name>
--head <sha>
```

## Managed coordinator rotation

Background: [coordinator rotation](coordinator-rotation.md).

| Command | What it does |
| --- | --- |
| `tc rotation prepare --checkpoint <file> [--key <attempt-key>]` | Starts a managed context rotation, records the JSON checkpoint and fences new dispatch. The checkpoint file must be outside the checkout. |
| `tc rotation show` | Shows the active rotation, checkpoint, drift, blockers and exact next action. |
| `tc rotation advance` | Advances the server-managed rotation after the old context has ended and a replacement is available. |
| `tc rotation resume --receipt <file>` | Submits the replacement context's JSON reconciliation receipt and lifts the dispatch fence. The receipt file must be outside the checkout. |

This family is for coordinator continuity, not routine worker `/clear` recovery.

## Session retirement

Background: [session finalize](session-finalize.md).

| Command | What it does |
| --- | --- |
| `tc finalize --reason "<why>"` | Finalizes this session only when its receipt is complete and safe-to-clear, it is drained and it has no unfinished work. |
| `tc finalize --session <id> --reason "<why>"` | Confirms/finalizes a named session in this pane's own project. |
| `tc finalize --project <name> --session <id> --reason "<why>"` | With lifecycle authority, finalizes a session in another project. |

Exit `3` means the finalize was refused or remains incomplete. Read its exact facts; when it says `FINALIZE_INCOMPLETE`, repeat the same command to finish.

## Branch safety

| Command | What it does |
| --- | --- |
| `tc branch check <name>` | Fetches/prunes the branch's remote and assesses whether deleting, resetting or removing its worktree would lose work. It does not mutate the branch. |
| `tc branch check <name> --json` | Returns the same assessment as structured JSON. |
| `tc branch check <name> --repo <path>` | Runs the assessment against the named repository. |

Only exit `0` means safe. Exit `3` means preserve; exit `4` means unknown. Neither is permission to delete or reset anything.

## Exit codes and failure posture

| Exit | Meaning |
| --- | --- |
| `0` | The command answered successfully; for safety checks, confirm that the documented verdict also grants the intended action. |
| `1` | Usage error (no verb, an unknown verb, a malformed command) or a missing session environment, such as `TANGLECLAW_API` not set. |
| `2` | API unreachable from this execution context, API refusal/error, or action failure. This alone does not prove the TangleClaw server is down. `tc` also exits 2, sending nothing, when this shell's launch identity differs from the one recorded for the pane it runs in. |
| `3` | Command-specific refusal/preserve result, notably `tc finalize` refusal/incomplete or `tc branch check` preserve. |
| `4` | `tc branch check` could not prove safety. |

Never turn a refusal into permission by improvising around `tc`. Report the exact stable error code and follow the corrective instruction it prints.

## Keeping this page true

The roster behind `tc --help` is the executable truth. A change that adds, removes or alters a `tc` verb or subcommand updates this page in the same change.

