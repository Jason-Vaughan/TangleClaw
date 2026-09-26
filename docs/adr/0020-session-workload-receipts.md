# ADR 0020: A session's workload is a launch-bound receipt it asserts, composed fail-closed with what the engine is observed doing

**Status:** Proposed (2026-09-26). Awaiting Architect ruling A17. No implementation begins before it.
**Source issue:** #1912: coordinators cannot tell from one read which Builder lanes are free,
waiting on CI, or unsafe to clear.
**Builds on:** ADR 0001 (one shared predicate for paired state), the A16 constraints for the Fleet
Workload Visibility train, the launch binding every `tc` verb carries (`TANGLECLAW_LAUNCH_ID`,
verified by `resolveAccess` in `lib/shared-docs-access.js`), and the wake monitor's engine-activity
verdicts (`lib/medusa-wake.js`).

---

## Context

To find capacity, the Architect had to combine three surfaces that do not agree on what they
describe:

- `tc sessions` / `GET /api/tc/sessions` lists live sessions and nothing about their work.
- `tc message status` reports mail and nudge state.
- `GET /api/sessions/:project/status` reports whether a pane is idle.

The decisive facts, such as "COMPLETE, SAFE TO CLEAR" or "RUNNING CI watch, DO NOT CLEAR", existed
only as prose in each pane. One Builder waiting on CI was read as available, and one that was free
was missed.

What exists today, and what it cannot carry:

- **Engine activity is observed, not asserted.** The wake monitor ticks every 5 s and keeps a
  per-session verdict (`turn-in-flight`, `agents-running`, `not-at-rest`, or at rest). It reads the
  engine profile's busy marker (`data/engines/*.json` `wake.busyMarker`) from the pane. That says
  whether the engine is mid-turn. It cannot say whether the *work* is finished: a pane at its prompt
  may be waiting on CI, on a review, or on the operator.
- **Every `tc` call already carries a launch binding.** The launch id is minted per launch
  (`mintLaunchId`, 16 random bytes) and exported only into that pane. `resolveAccess` verifies it:
  the launch must exist, belong to the claimed project, and its session must be `active`. It
  returns the project id taken from the store record, never from the claim. It does not yet return
  the session or launch id.
- **Nothing that exists is launch-scoped workload.** The READY attestation (`launch_sequences`) is
  write-once per launch and records initialization, not ongoing work. The awareness receipts
  (`awareness_receipts`) record that a verb was called, keyed by the *claimed* project, and are not
  launch-verified. Control state (`control_assignments`) is the authorities' hold/stop over a lane,
  not the lane's own account of its work.
- **No code parses pane text for STATE or clearance lines today.** That absence is worth keeping.

## Decision

### 1. One workload-specific write surface: `tc workload set`

A session reports its workload only through a dedicated verb and route. Nothing else writes it.

```
tc workload set <state> --clearance <clearance> --summary "<one line>"
                [--wait <kind> [--wait-detail "<text>"]]
                [--issue N]... [--pr N]... [--task "<id>"]...
                [--branch <name>] [--head <sha>]
tc workload show            # this lane's current receipt and composed verdict
```

- **Route:** `POST /api/tc/workload`, with body schema `tc.workload/1`. The route is not a generic
  PATCH on the session, and no other route, dashboard control or wrap step writes a receipt.
- **Only a launch-verified project caller may write.** `resolveAccess` must answer `kind:
  'project'`. `operator`, `master`, `unbound` and `invalid` callers are refused: `403
  WORKLOAD_BINDING_REQUIRED`, with the resolver's reason code. So a browser, a curl without a live
  launch id, or another project's session cannot write a lane's workload. Project Master sessions
  are out of scope for this train, and their lanes compose to `UNKNOWN` (§5).
- **The write is the session's own assertion, recorded as such.** The verb is how an agent says what
  it is doing. It is never evidence that the work is correct, and it grants nothing.

### 2. The server derives and stamps identity, provenance and time

The caller supplies only the asserted fields in §3. Everything that identifies or dates the receipt
comes from the verified binding and the server:

| Field | Source |
|---|---|
| `project_id` | the launch record `resolveAccess` verified |
| `session_id` | `launch.sessionId` from the same record (`resolveAccess` is extended to return it) |
| `launch_id` | the verified launch record, not the header string |
| `seq` | server-assigned, strictly increasing per launch |
| `received_at` | server clock at commit |
| `source` | `'tc-cli'`, only when the request carries the `tc` CLI and verb headers *and* passed launch verification; otherwise the write is refused, not recorded under another source |

A body containing any of these keys, or any key outside the §3 schema, is refused with `400
WORKLOAD_FIELD_NOT_WRITABLE`, naming the key. Unknown keys are refused rather than ignored, so a
caller cannot believe it set a field the server discarded.

**Storage.** A new append-only table `workload_receipts` (schema v50) holds the columns above plus
the §3 fields, with CHECK-constrained enums and an append-only trigger, in the pattern of
`control_events`. A lane's *current* receipt is the highest `seq` for its current launch. History is
kept for audit and never rewritten.

### 3. Exact states, clearance, wait kinds and bounds

**Asserted workload state (`state`),** one of:

| Value | Meaning |
|---|---|
| `working` | actively executing an accepted task |
| `waiting-external` | the next step depends on something outside this session: CI, a review, the operator, a peer, a merge |
| `blocked` | cannot proceed without a decision or fix it cannot make itself |
| `complete` | the accepted task is finished and nothing of it is in flight |

**Asserted clearance (`clearance`),** one of `safe-to-clear`, `do-not-clear`, `unknown`. It answers
"may this session's context be cleared or reassigned without losing work?"

**Consistency rules, enforced at write (`400 WORKLOAD_INCONSISTENT`):**

- `working` requires `do-not-clear`. Work in flight is never safe to clear.
- `waiting-external` requires `--wait` with a kind from `ci | review | operator | peer | merge |
  other`. Clearance may be any value: a CI watch that can be resumed from a PR is `safe-to-clear`
  only when the session says so.
- `blocked` requires a summary naming the blocker.
- `complete` may carry any clearance. `complete` + `do-not-clear` is legal (for example, forward
  notes not yet written) and never composes to `AVAILABLE`.

**Bounds:**

- `summary`: 1–200 characters, one line, no control characters.
- `wait_detail`: at most 200 characters.
- Up to 10 each of `issue` and `pr` (positive integers) and `task` (at most 64 characters each).
- `branch`: at most 255 characters, following git ref-name rules.
- `head`: exactly 40 lowercase hex characters.
- A lane may write at most one receipt per second; a faster write gets `429 WORKLOAD_RATE`.

### 4. Freshness and supersession: a receipt is current or it is nothing

A receipt is **current** only while all of these hold:

1. Its `launch_id` is the session's live launch, and the session's status is `active`. A new launch,
   wrap, kill or crash makes it non-current by construction, because the next launch has a
   different launch id and nothing is carried across.
2. No **supersession event** for the lane has been recorded after its `received_at`. Supersession
   events are recorded by the server, never inferred from text:
   - A Medusa exchange addressed to the lane is delivered (a new dispatch).
   - A control event on the lane's assignment: hold, release, stop, rebind, or close.
   - A wrap is requested or started for the session.
3. Its age is within the **freshness window** for its state:

   | State | Window |
   |---|---|
   | `working` | 30 min |
   | `waiting-external` | 120 min |
   | `blocked` | 120 min |
   | `complete` | no age limit, since only events end it |

   A long-running lane keeps a receipt current by re-asserting it; the rate limit makes that cheap.
   These windows are constants in one module, named in the capability report, and ratified with
   this ADR (A17). Changing them is a code change with a test, not a setting.

A receipt that fails any of these is **stale**. Stale means the assertion no longer counts. It is
still shown, with its age and why it went stale, so a coordinator can see what the lane last said.

### 5. Composition: engine activity and asserted workload stay separate, and combine fail-closed

Every lane in the fleet read carries three separate blocks, and no field is copied between them:

- **`engine`** holds what the engine was **observed** doing: `activity` ∈ `busy | at-rest | unknown`,
  `reason` (the wake monitor's code), `observedAt`, `provenance: 'engine-observed'`. It is read from
  the wake monitor's cached verdict. It never comes from a new pane capture made for this read.
- **`workload`** holds the current or stale receipt exactly as stored, plus `provenance` ∈
  `explicit-receipt | stale | none`, `ageSeconds`, and `staleReason` when stale.
- **`composed`** holds the verdict a coordinator acts on, built only by the rules below: `availability`,
  `clearance`, and `reasons[]` naming each rule that fired.

**The composition is one pure function** of (session status, control state, engine block, workload
block), evaluated top to bottom, first match wins:

| # | Condition | `availability` | `clearance` |
|---|---|---|---|
| 1 | session not `active`, or a Project Master lane | `UNKNOWN` | `unknown` |
| 2 | control assignment `held` or `stopped` | `HELD` | from the receipt if current, else `unknown`, never upgraded |
| 3 | engine `busy` | `WORKING` | `do-not-clear` |
| 4 | no current receipt (none, stale or malformed) | `UNKNOWN` | `unknown` |
| 5 | receipt `working` | `WORKING` | `do-not-clear` |
| 6 | receipt `waiting-external` | `WAITING` | as asserted |
| 7 | receipt `blocked` | `BLOCKED` | as asserted |
| 8 | receipt `complete` + `safe-to-clear` + engine `at-rest` | `AVAILABLE` | `safe-to-clear` |
| 9 | receipt `complete`, any other case (engine `unknown`, or clearance not safe) | `COMPLETE_NOT_CLEAR` | as asserted, capped at `do-not-clear` when the engine is `unknown` |

The rules guarantee four properties, and each one gets a test:

- **Busy overrides assertion (rule 3).** A busy marker after a safe receipt composes `WORKING`,
  `do-not-clear`.
- **Idleness never upgrades.** No rule reaches `AVAILABLE` or `safe-to-clear` without a current
  receipt that says so. `engine: at-rest` alone composes `UNKNOWN` (rule 4).
- **Absence is `UNKNOWN`, not available.** No receipt, a stale receipt and an unauthorized write all
  land in rule 1 or rule 4.
- **`AVAILABLE` needs both.** The session says it is complete and safe, *and* the engine is observed
  at rest (rule 8).

### 6. Operator overrides only ever narrow

The operator (and only the operator principal, as with control holds) may pin a lane's composed
verdict:

- **What an override can do:** pin the lane to `unknown` or `do-not-clear`, with a reason, recorded
  append-only with `operator_proof` like a control event.
- **What it can never do:** raise a lane to `safe-to-clear` or `AVAILABLE`. Only the session itself
  can assert that about its own work, and rule 8 still requires the engine at rest.
- **How long it lasts:** it ends with the launch, or when the operator clears it.
- **How it shows:** it composes ahead of rule 3 and appears in `reasons[]` as `operator-override`.

ProjectManager and Architect sessions cannot override. They coordinate through dispatch, which already
supersedes a receipt (§4), and through control holds, which already compose to `HELD`.

### 7. Transcript parsing is banned as a source of workload or clearance

No code path may derive `state`, `clearance`, `availability` or any `composed` field from pane text,
transcript files or captured output. That includes this repository's own `STATE`, `RUNNING`,
`COMPLETE`, `SAFE TO CLEAR` and `DO NOT CLEAR` lines. Pane reads remain allowed for exactly one
purpose, **engine activity** (the busy marker and at-rest detection), and that input can only
*downgrade* a verdict (rule 3), never assert one.

Enforcement:

- A test scans `lib/`, `server.js` and `public/` and fails on any pattern that matches those clearance
  phrases outside tests and prose.
- The composition function takes no pane text as input, so this is enforced by its signature, not
  only by review.

The agent-facing guidance (the injected operational guide and the session prime) tells a session to
run `tc workload set` wherever it would write one of those lines. The visible lines stay a courtesy
to a human reader, not a contract.

### 8. When a session emits, and what the server does without it

The guidance asks for a `tc workload set` at:

- dispatch acceptance
- each meaningful task transition
- the start of any external wait (CI, review, operator input, merge)
- completion
- before wrap
- before an intentional exit

The server does not synthesize receipts for any of these. It only records the supersession events in
§4, so a session that stops reporting composes to `UNKNOWN` rather than to whatever it last said.

### 9. Surfaces read one composition, with no new fleet-wide synchronous scans

- **The fleet read:** `GET /api/tc/sessions` adds `engine`, `workload` and `composed` per lane, from
  SQLite plus the wake monitor's in-memory verdicts. The route keeps its current property of running
  no tmux capture or probe per request.
- **Its consumers:** `tc sessions`, a new `tc workload show`, and the dashboard / Master fleet views
  render that same response. None re-derives the composition, which lives in one module (ADR 0001).
- **Unobserved engines:** a lane the wake monitor is not observing (engine without a wake profile,
  monitor off) has `engine.activity: unknown`, and rule 9 caps it. The read never starts a scan to
  fill the gap.

## Consequences

- **A lane is `AVAILABLE` only on two independent kinds of evidence,** its own current assertion and
  observed engine rest. That removes the two misclassifications in #1912: a CI-waiting lane now
  composes `WAITING`, and a free lane that says so composes `AVAILABLE`.
- **A silent lane reads `UNKNOWN`.** Coordinators must treat `UNKNOWN` as "ask", not "assign". That is
  more friction than today's guessing, and it is honest.
- **Receipt writing is new work for every session.** Until the guidance lands and sessions adopt it,
  most lanes compose `UNKNOWN`. The rollout is additive: nothing that exists changes meaning.
- **`resolveAccess` grows two return fields** (`sessionId`, `launchId`). Every existing caller ignores
  them, and its refusal semantics are unchanged.
- **Schema v50 adds one append-only table,** which grows with every receipt. At one receipt per second
  at most, per live launch, that is small. A retention sweep is deferred until it is measured.
- **The freshness windows are a judgment call** ratified here, and will be wrong for some tasks. A
  lane that outlives its window re-asserts; it is never silently trusted.

## Rejected alternatives

- **Parse the pane's STATE / SAFE TO CLEAR lines.** They are free-form, spoofable by any text an agent
  prints or quotes, and not bound to a launch. A16 bans it, and §7 makes the ban structural.
- **Let the caller supply session id, launch id or timestamps.** Every identity field would then be a
  claim. The awareness-receipt path shows the cost: it keys on the claimed project and cannot prove
  who wrote it.
- **Reuse the awareness receipts or the READY attestation.** The first is not launch-verified and
  records verb calls, not work. The second is write-once initialization. Stretching either would
  change what existing readers believe.
- **Treat pane idleness as availability.** It is exactly the #1912 failure: a pane at its prompt
  waiting on CI looks idle.
- **Let PM or Architect sessions set another lane's workload.** That is a claim about someone else's
  work. Dispatch and control holds already give coordinators the levers they need, and neither can
  make a lane look free.
- **Carry a receipt across launches** (for example, so a relaunched session is available at once). A
  new launch is a new context. Its availability must be asserted afresh.

## Implementation sequence (non-normative, for the train plan after A17)

1. `workload_receipts` (v50), `resolveAccess` returning `sessionId`/`launchId`, `POST
   /api/tc/workload` with §2–§3 validation, `tc workload set/show`.
2. The composition module (§5) with the §4 supersession events recorded, surfaced on `GET
   /api/tc/sessions` and `tc sessions`. The six #1912 acceptance cases are tests here.
3. Operator overrides (§6), the transcript-parsing guard test (§7), and the injected guidance (§8).
4. Dashboard and Master fleet views reading the same response (§9).
