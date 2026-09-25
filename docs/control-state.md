# Durable HOLD/STOP control state

*Experimental (#1861). Internal but documented; the API and `tc control` may change while the
dual-Builder train settles.*

## Why it exists

On 2026-09-25 a Builder acted on a legitimate go-ahead while three later HOLD/STOP messages sat
unread in its Medusa inbox. Delivery timing cannot enforce a boundary: a message that has not
arrived is indistinguishable, to the agent, from a message that was never sent.

Control state makes HOLD and STOP **durable facts stored by TangleClaw**. A newer HOLD wins over
an older go-ahead the moment it is stored, whether or not anyone has read about it, and every
TangleClaw-owned mutation checks the stored state immediately before it acts.

## What it can and cannot stop

Read this before relying on it.

- **Enforced (server-side):** every mutation TangleClaw itself performs. That covers:
  - wrap start, and every step boundary of a running wrap;
  - the commit step's branch, release-prepare and commit;
  - the auto-PR push, PR create and auto-merge arming;
  - the `pr-merge` step's push and arming;
  - the stranded-wrap "open PR";
  - command injection into a pane, project actions, and the startup prompt. The one exemption is
    the switchboard wake nudge, because it is how a HOLD notice reaches the pane;
  - `POST /api/server/restart` and `POST /api/update/apply`;
  - launching a new session into a stopped lane.
- **Defense in depth only (managed git hooks):** `git commit` and `git push` run from a shell in
  a governed checkout. The hooks are bypassed by any of these:
  - `--no-verify`;
  - changing `core.hooksPath`;
  - deleting or editing the hook or the marker;
  - `GIT_DIR` tricks;
  - calling GitHub directly with `gh` or `curl`.
- **Not enforced at all:** a few actions have no local hook to catch them:
  - `gh pr ready`, `gh pr merge`, `git tag` and `gh release` run from a shell;
  - anything done at GitHub with the operator's shared credentials;
  - a manual `git pull` of a live checkout (only the restart half of a live sync is gated).
- **Attribution is supervised-grade.** A launch id is a bearer value in the pane's environment,
  and any local process that can read it can present it. This design targets trustworthy
  supervised agents, not hostile ones.

The accurate claim is:

> HOLD is durable and authoritative. Every TangleClaw-owned mutation path refuses it before its
> side effect. The agent is shown it at its next `tc` call, gate refusal, or hook refusal.
> Direct shell mutation remains a trust boundary.

## Model

- **Assignment.** A project has at most one open assignment. It has these parts:
  - an opaque id (`asg_…`);
  - the target project;
  - an **authority matrix**, set by the operator at creation;
  - the target's current session and launch binding.
- **State.** An assignment is `active`, `held`, `stopped` or `closed`.
  - The **state generation** is assigned by the server.
  - It moves only on create, hold, release and stop.
- **Holds are cumulative.** Each HOLD is its own named hold. The assignment stays `held` while any
  hold is active.
- **RELEASE** names the holds it clears (`holdIds`) and the generation the releaser saw
  (`expectedGeneration`). A release built on an older generation is refused
  (`409 STALE_GENERATION`), so a delayed go-ahead can never clear a newer HOLD.
- **STOP is terminal.**
  - Nothing releases it, and a stopped assignment keeps governing its project.
  - An ordinary launch into a stopped project is refused.
  - The only way to resume is an operator-created successor assignment, which supersedes the
    stopped one in the same transaction.
  - Work admitted under the stopped assignment stays refused.
- **Close** is only for a finished, **active** assignment with no holds:
  - held gives `409 ACTIVE_HOLDS`;
  - stopped gives `409 STOP_TERMINAL`.
- **Audit.**
  - `control_events` records state changes.
  - `control_receipts` records delivery and acknowledgement facts.
  - Both are append-only: the database refuses UPDATE and DELETE on them.
  - Receipts never change the state generation.
- **Accepted means stored.**
  - A command's event and a `notify_pending` receipt commit in one transaction before the response.
  - The Medusa notice is attempted afterwards, and its outcome is recorded as `notify_attempted`.
  - A failed notice never undoes the command.
- **Schema:** v48 adds `control_assignments`, `control_holds`, `control_events` and
  `control_receipts`.

## Who may do what

Principals are `operator` and `project:<id>`. A project principal is a **verified launch**: the
`x-tangleclaw-launch-id` exists, its project matches `x-tangleclaw-project-id`, and its session is
active. None of these is a principal:
- a URL project name;
- a Medusa sender;
- a service token;
- a role name or a workspace prefix;
- a connected listener.

| Action | Who |
|---|---|
| Create an assignment (and a successor after STOP) | Operator only |
| HOLD | Operator, anyone in `authority.hold`, or the target itself (self-hold) |
| RELEASE a hold | Operator (any named hold); the hold's own issuer; or a principal the matrix delegates (`releaseDelegations`). **Never the target.** The PM and the Architect cannot clear each other's holds by role |
| STOP | Operator or anyone in `authority.stop` (never the target) |
| Close | Operator or anyone in `authority.lifecycle` |
| Acknowledge | The target's currently bound launch, for the current generation only |

**Operator proof tier.** An operator-only command needs one of these:

| Tier | When | Accepted? |
|---|---|---|
| `verified-session` | A signed-in account session, in any gate state | Yes |
| `ambient-open` | The auth gate is deliberately `open` (no identity boundary on this install) | Yes. Recorded on every event, and not authentication |
| Unverifiable | `fallback` with no session; `unreadable` | No: `503 CONTROL_OPERATOR_UNVERIFIABLE` |
| Not the operator | `armed`, `locked` or `account-required` with no session | No: `403` |

The dashboard header on its own (`x-tangleclaw-client: dashboard`) never authorizes a control
command.

## Restart and update-apply

These routes gate the **caller**, and `force: true` never bypasses the gate:

| Caller | Result |
|---|---|
| The verified operator | Allowed |
| A verified launch whose own assignment is clear (a PM doing live sync) | Allowed, even while another lane is held |
| A verified launch whose own assignment is held or stopped | `423` |
| No binding, a mismatched or stale binding, or the Project Master, while any lane is held or stopped | `423 CONTROL_CALLER_UNATTRIBUTABLE` (a Master launch proves identity, not operator authority) |

A scripted live sync must therefore send its own `x-tangleclaw-project-id` and
`x-tangleclaw-launch-id`. `GET /api/update-status` and `POST /api/update/check` are not gated.

## API

All routes are JSON. Control commands take `requestId` (1–128 characters of `[A-Za-z0-9._:-]`) as an
idempotency key: replaying one returns the original result.

```
POST /api/control/assignments                    {projectId, requestId, issueRef?, authority?}   operator only
     authority: {hold: [principals], stop: [...], lifecycle: [...], releaseDelegations: {"project:70": ["project:74"]}}
GET  /api/control/assignments                    every open assignment (operator only)
GET  /api/control/assignments/:id                full status: assignment, holds, events with receipts
POST /api/control/assignments/:id/hold           {requestId, reasonCode, expectedGeneration?}
POST /api/control/assignments/:id/release        {holdIds, expectedGeneration, requestId, reasonCode}
POST /api/control/assignments/:id/stop           {requestId, reasonCode}
POST /api/control/assignments/:id/close          {requestId, reasonCode}
POST /api/control/assignments/:id/ack            {stateGeneration}                  the target's bound launch
POST /api/control/assignments/:id/exchange-closed {eventId}                         the issuer or the operator
GET  /api/control/mine                           the calling launch's own open assignment, plus managed-hook status
GET  /api/control/check?assignmentId=            {state, stateGeneration, blocked, code}; needs no binding (used by the hooks)
```

Reason codes are a bounded list per command (`lib/control-state.js#REASON_CODES`); free prose is
refused.

**Codes:**
- `423`: `CONTROL_HELD`, `CONTROL_STOPPED` or `CONTROL_CALLER_UNATTRIBUTABLE` at a mutation gate.
- `503`: `CONTROL_STATE_UNAVAILABLE` (the store could not be read, so the governed mutation fails
  closed) or `CONTROL_OPERATOR_UNVERIFIABLE`.
- `409`:
  - `STALE_GENERATION`
  - `HOLD_NOT_ACTIVE`
  - `ASSIGNMENT_STOPPED`
  - `ASSIGNMENT_CLOSED`
  - `ASSIGNMENT_OPEN` (a second open assignment)
  - `ACTIVE_HOLDS`
  - `STOP_TERMINAL`
- `403`: `CONTROL_UNAUTHORIZED`.
- `400`: `CONTROL_MALFORMED`.

Refusals carry the assignment id, the current state generation and the active hold ids. They never
carry commands, paths, launch ids or free-text reasons.

## From a pane: `tc control`

```
tc control status                                    your lane, its holds, and whether shell git is intercepted here
tc control ack <generation>                          acknowledge the state you saw
tc control hold <assignment-id> <reason>             with authority (or on your own lane)
tc control release <assignment-id> <generation> <reason> <hold-id…>
tc control stop <assignment-id> <reason>
```

Every other `tc` verb prints a one-line `HELD (gen N, k holds)` notice while your lane is held.
This is visibility, not enforcement. A launch into a held lane says so in its launch context
before any work.

## Managed git hooks

When a project is governed, TangleClaw writes a machine-local marker and installs `pre-commit` and
`pre-push` dispatchers where git reads hooks (`git rev-parse --git-path hooks`). The marker is
`<git-dir>/tangleclaw-control.json`, which holds `{assignmentId, api}` and is never committed.

- **Governed checkout.** The hook asks `GET /api/control/check`:
  - blocked: it refuses, with the code and generation;
  - TangleClaw unreachable, or the marker unreadable: it **fails closed**.
- **Ungoverned checkout** (no marker): the hook only runs any chained hook.
- **Linked worktrees.**
  - A governed *main* checkout also marks its common git dir, so worktrees the Builder creates under
    it share its lane.
  - A registered project that is itself a linked worktree of that clone gets an explicit
    `{ungoverned: true}` marker, so two projects sharing one clone stay isolated.
  - A governed linked worktree does not govern its clone's main checkout.
- **Foreign hooks** are preserved and chained, never overwritten.
  - An existing hook is renamed to `<hook>.tc-chained`. The rename keeps its type, its bytes or
    link target, and its mode.
  - Its fingerprint is recorded in `tangleclaw-control-hooks.json` in the hooks directory.
  - After the check passes, the dispatcher `exec`s it with the original arguments and stdin, so
    its exit status and signal are its own.
  - Install is transactional: any failed step restores the original.
  - An unexplained existing `.tc-chained` file is a collision, so install refuses and changes
    nothing.
  - Uninstall restores only a chained hook whose fingerprint still matches. Anything else is
    refused with the exact recovery commands.
- **A `core.hooksPath` inside the work tree** (tracked, such as `.husky/`) is never written. The
  checkout reports `UNPROTECTED (tracked hooksPath)` in `tc control status`.

## Recovery

There is no override or bypass endpoint. The audited recovery paths are:

- **A lane held by mistake:** the operator releases the named holds, with `expectedGeneration` and
  a reason code. The release is recorded with the operator's proof tier.
- **After a STOP:** the operator creates a successor assignment for the project. It supersedes
  the stopped one atomically, starts at generation 1, and the next launch rebinds to it.
- **Control store unreadable:** governed mutations answer `503 CONTROL_STATE_UNAVAILABLE`.
  A project is known to be governed from the store at boot, and from every control command and
  rebind since. A project known to be ungoverned is unaffected. Until the boot-time read has
  succeeded, every governed-shaped check is refused. Fix the store, then Retry the wrap.

## Rolling back

The managed hooks fail closed when their check does not answer. A server rolled back to a version
without control state answers `GET /api/control/check` with 404, so **every governed checkout would
refuse `git commit` and `git push`** until its hooks and markers are removed. Remove them first.

**Before rolling back** (from a checkout of this version), for each governed project checkout:

```sh
node -e "require('./lib/control-hooks').uninstall(process.argv[1])" /path/to/project/checkout
rm -f "$(git -C /path/to/project/checkout rev-parse --git-dir)/tangleclaw-control.json" \
      "$(git -C /path/to/project/checkout rev-parse --git-common-dir)/tangleclaw-control.json"
```

`uninstall` puts any chained hook back byte-for-byte. It refuses, and prints the exact commands,
when a chained hook changed after TangleClaw moved it.

**If the server was already rolled back,** do it by hand in each governed checkout. In the directory
`git rev-parse --git-path hooks` names:
1. Delete `pre-commit` and `pre-push` if their second line is `# TC-OWNED-HOOK: control-state`.
2. Rename `pre-commit.tc-chained` and `pre-push.tc-chained`, where present, back to
   `pre-commit` and `pre-push`.
3. Delete `tangleclaw-control-hooks.json`.
4. Delete `tangleclaw-control.json` from `git rev-parse --git-dir` and from
   `git rev-parse --git-common-dir`.

A checkout with no marker is never refused, so removing the markers alone is enough to unblock
commits. Removing the hooks restores the checkout exactly.

`git commit --no-verify` and `git push --no-verify` also get past the hooks in an emergency.

## Code

- `lib/control-state.js`: the rules (state machine, authority, generations, receipts).
- `lib/control-auth.js`: caller resolution and the operator proof tier.
- `lib/control-api.js`: the route handlers and the post-response notice.
- `lib/control-gate.js`: `checkMutation`, called before each governed side effect.
- `lib/control-hooks.js`: the managed hooks and markers.
- `lib/store.js`: the v48 tables and `store.control`.
