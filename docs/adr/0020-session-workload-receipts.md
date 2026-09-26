# ADR 0020: A session's workload is a launch-bound receipt it asserts, composed fail-closed with what the engine is observed doing

**Status:** Proposed. FWV-A17 (2026-09-26) required revisions, and this is the revised draft,
awaiting FWV-A18. No implementation begins before approval.
**Source issue:** #1912: coordinators cannot tell from one read which Builder lanes are free,
waiting on CI, or unsafe to clear.
**Builds on:** ADR 0001 (one shared predicate for paired state), the A16 constraints for the Fleet
Workload Visibility train, the launch binding every `tc` verb carries (`TANGLECLAW_LAUNCH_ID`,
verified by `resolveAccess` in `lib/shared-docs-access.js`), and the pane-assessment helpers in
`lib/medusa-wake.js` (`_assessActivity`, `_composerEmpty`).
**Depends on:** a durable typed assignment-dispatch event (§4). It does not exist yet.

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

- **No continuous fleet activity observation exists.** The wake monitor (`lib/medusa-wake.js`)
  ticks every 5 s, but it stops for a session at no-mail, before any pane or engine observation, and
  probes only when a wake is pending. Its verdicts cover sessions with mail, not the fleet.
  `GET /api/sessions/:project/status` observes one pane synchronously per request. What does exist
  is the assessment logic: `_assessActivity` (turn in flight, agents running, not at rest) and
  `_composerEmpty`. They are reusable. The loop that would drive them fleet-wide is missing.
- **Every `tc` call already carries a launch binding.** The launch id is minted per launch
  (`mintLaunchId`, 16 random bytes) and exported only into that pane. `resolveAccess` verifies it:
  the launch must exist, belong to the claimed project, and its session must be `active`. It
  returns the project id taken from the store record, never from the claim. It does not yet return
  the session or launch id.
- **Nothing that exists is launch-scoped workload.** The READY attestation (`launch_sequences`) is
  write-once per launch and records initialization. The awareness receipts (`awareness_receipts`)
  record that a verb was called, keyed by the *claimed* project, and are not launch-verified. Control
  state (`control_assignments`) is the operator's assignment and hold/stop over a lane, bound to the
  lane's launch (`bound_launch_id`). It is not the lane's own account of its work.
- **No typed dispatch exists.** A Medusa exchange carries free-text `reason_code` (at most 40
  characters) and no type distinguishing a work assignment from an acknowledgement, a review result
  or ordinary coordination.
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
  launch id, or another project's session cannot write a lane's workload.
- **Project Master lanes are out of scope.** They compose `UNKNOWN` with reason
  `unsupported-master-lane` (§6). No project launch binding is fabricated for them.
- **The write is the session's own assertion, recorded as such.** The verb is how an agent says what
  it is doing. It is never evidence that the work is correct, and it grants nothing.

### 2. The server derives and stamps identity, provenance, sequence and time

The caller supplies only the asserted fields in §3. Everything that identifies or dates the receipt
comes from the verified binding and the server:

| Field | Source |
|---|---|
| `project_id` | the launch record `resolveAccess` verified |
| `session_id` | `launch.sessionId` from the same record (`resolveAccess` is extended to return it) |
| `launch_id` | the verified launch record, not the header string |
| `assignment_id` | the id of the open `control_assignments` row whose `bound_launch_id` is this launch; `NULL` when there is none |
| `seq` | server-assigned, strictly increasing per launch |
| `received_at` | server clock at commit |
| `source` | `'tc-cli'`, only when the request carries the `tc` CLI and verb headers *and* passed launch verification; otherwise the write is refused, not recorded under another source |

A body containing any of these keys, or any key outside the §3 schema, is refused with `400
WORKLOAD_FIELD_NOT_WRITABLE`, naming the key. Unknown keys are refused rather than ignored, so a
caller cannot believe it set a field the server discarded.

**Storage.** A new append-only table `workload_receipts` (schema v50) holds the columns above plus
the §3 fields, with CHECK-constrained enums and an append-only trigger, in the pattern of
`control_events`.

- **Sequence is transactional and unique.** `UNIQUE (launch_id, seq)`. The server allocates `seq`
  inside the same write transaction as the insert (`BEGIN IMMEDIATE`; `seq = COALESCE(MAX(seq), 0) +
  1` for the launch). A concurrent write therefore either takes the next number or fails the
  constraint and is retried once. It never duplicates or reorders.
- **A lane's current receipt** is the highest `seq` for its current launch. History is kept for audit
  and never rewritten.

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

### 4. Freshness and supersession: no assertion is trusted forever

A receipt is **current** only while all of these hold:

1. **It belongs to the live launch.** Its `launch_id` is the session's live launch, and the
   session's status is `active`. A new launch, kill or crash makes it non-current by construction:
   the next launch has a different launch id, and nothing is carried across.
2. **No supersession event has followed it.** The server records these events itself; none is
   inferred from message text or from mail arriving:
   - **Control lifecycle:** a hold, release, stop, rebind or close on the lane's assignment
     (`control_events`).
   - **Wrap lifecycle:** a wrap requested or started for the session.
   - **Typed dispatch (a dependency):** a durable assignment-dispatch event, typed as a dispatch,
     bound to this lane's launch and to its assignment.
     - That event does not exist today. Ordinary Medusa deliveries are *not* dispatches: an
       acknowledgement, a review result or coordination traffic supersedes nothing.
     - This ADR does not guess a dispatch from message prose, from `reason_code` or from any mail.
     - Typed dispatch is a named prerequisite, specified separately. Until it lands, dispatch
       supersession is not implemented, and the expiry in point 3 is what bounds a receipt that a
       new assignment should have ended.
3. **It is younger than its state's expiry:**

   | State | Expires after |
   |---|---|
   | `working` | 30 min |
   | `waiting-external` | 120 min |
   | `blocked` | 120 min |
   | `complete` | 120 min |

   The `complete` expiry exists because work can reach a lane with no event this system sees: direct
   operator text, lost dispatch telemetry, or work accepted outside Medusa. A lane that is still
   complete and free re-asserts; the rate limit makes that cheap. The windows are constants in one
   module, named in the capability report. Changing them is a code change with a test, not a
   setting.

A receipt that fails any of these is **stale**. Stale means the assertion no longer counts. It is
still shown, with its age and why it went stale, so a coordinator can see what the lane last said.

### 5. Engine activity comes from a bounded background observer, never from the fleet read

A new **activity observer** (`lib/activity-observer.js`) is the only source of the `engine` block.
It runs independently of inbox state.

**What it observes.** Each tick, for each live project session whose engine has a wake profile, it
makes one pane capture. It then applies the existing assessment helpers (`_assessActivity`,
`_composerEmpty`) and produces one of:

| `activity` | Meaning |
|---|---|
| `busy` | a turn is in flight (busy marker, or the fingerprint above the composer changed since the last tick), or agents are running |
| `at-rest` | the **strict at-rest gate** passed: no busy marker, the fingerprint above the composer unchanged across two consecutive observations, no running agents, **and an empty composer** |
| `not-at-rest` | neither: for example, text in the composer, or a single observation not yet confirmed |
| `unknown` | no wake profile for the engine, capture failed or timed out, or the observation is stale |

Output idleness alone never yields `at-rest`.

**Resource budget:**

- **Tick:** every 10 s. Captures run serially, never in parallel.
- **Per capture:** at most one per live session per tick, with a 1 s tmux timeout.
- **Per tick:** 3 s of wall time. A session not reached in a tick keeps its previous observation, which
  ages, and the next tick starts where this one stopped (round-robin), so no session starves.
- **Scale:** in the worst case every capture hits its 1 s timeout, so a tick reaches 3 sessions. With
  the 30 s freshness window (three ticks), that keeps up to 9 sessions fresh; faster captures fit
  more. Capture latency on this host has not been measured; the observer's implementation measures it before the
  budget is final. Past the budget, freshness degrades to `unknown` rather than the observer growing.
- **Storage:** in memory only, one record per session, no history. Each record holds `activity`,
  `reason`, `observedAt` and the fingerprint the two-observation rule needs.
- **Not observed at all:** sessions whose engine has no wake profile, and every non-`active` session.

**Freshness contract.** An observation is fresh while `now - observedAt ≤ 30 s` (three ticks). A
stale observation reads as `unknown`. The fleet read reports `observedAt` and `ageSeconds` with every
engine block.

**No synchronous capture on read.** `GET /api/tc/sessions` and every surface built on it read the
observer's cache. They never capture or probe a pane. The existing per-request status route is
unchanged and is not a source for the fleet read.

### 6. Composition: engine activity and asserted workload stay separate, and combine fail-closed

Every lane in the fleet read carries three separate blocks, and no field is copied between them:

- **`engine`** is the observer's record (§5), with `provenance: 'engine-observed'`.
- **`workload`** is the current or stale receipt exactly as stored, plus `provenance` ∈
  `explicit-receipt | stale | none`, `ageSeconds`, and `staleReason` when stale.
- **`composed`** is the verdict a coordinator acts on: `availability`, `clearance`, and `reasons[]`
  naming every rule that fired.

**Base composition** is one pure function of (session status, lane kind, control state, engine
block, workload block), evaluated top to bottom, first match wins:

| # | Condition | `availability` | `clearance` |
|---|---|---|---|
| 1 | session not `active` | `UNKNOWN` | `unknown` |
| 2 | Project Master lane | `UNKNOWN` (reason `unsupported-master-lane`) | `unknown` |
| 3 | control assignment `stopped` | `STOPPED` | `do-not-clear` if engine `busy`, else from a current receipt capped at `do-not-clear`, else `unknown` |
| 4 | control assignment `held` | `HELD` | same as rule 3 |
| 5 | engine `busy` | `WORKING` | `do-not-clear` |
| 6 | no current receipt (none, stale or malformed) | `UNKNOWN` | `unknown` |
| 7 | receipt `working` | `WORKING` | `do-not-clear` |
| 8 | receipt `waiting-external` | `WAITING` | as asserted |
| 9 | receipt `blocked` | `BLOCKED` | as asserted |
| 10 | receipt `complete` + `safe-to-clear` + engine `at-rest` (fresh, strict) | `AVAILABLE` | `safe-to-clear` |
| 11 | receipt `complete`, any other case (engine `not-at-rest` or `unknown`, or clearance not safe) | `COMPLETE_NOT_CLEAR` | as asserted, capped at `do-not-clear` unless rule 10 held |

**Operator narrowing is applied after the base composition,** as a monotone restriction (§7). It can
only lower the base verdict and never replace it.

The rules guarantee five properties, and each one gets a test:

- **Busy overrides assertion (rule 5).** A busy observation after a safe receipt composes `WORKING`,
  `do-not-clear`.
- **Idleness never upgrades.** No rule reaches `AVAILABLE` or `safe-to-clear` without a current
  receipt that says so. `at-rest` alone composes `UNKNOWN` (rule 6).
- **Absence is `UNKNOWN`, not available.** No receipt, a stale receipt, an expired `complete` receipt,
  a stale observation and an unauthorized write all land in rules 1, 2, 6 or 11.
- **`AVAILABLE` needs both.** The session says it is complete and safe, *and* the observer has fresh,
  strict evidence the engine is at rest (rule 10).
- **Control verdicts are hard.** A held or stopped lane is never `AVAILABLE`, and never reads safe
  while its engine is busy.

### 7. Operator narrowing is a monotone restriction applied last

The operator (and only the operator principal, as with control holds) may record a narrowing on a
lane:

- **What it can do:** cap `clearance` at `do-not-clear`, and force availability to `UNKNOWN` when the
  base availability is `AVAILABLE`, `COMPLETE_NOT_CLEAR`, `WAITING` or `BLOCKED`.
- **What it can never do:** hide `WORKING`, `HELD` or `STOPPED`. Those keep their availability, and
  only the clearance cap applies. It never raises anything: only the session can assert its own
  clearance, and rule 10 still requires the engine at rest.
- **How it is recorded:** append-only, with `operator_proof`, like a control event.
- **How long it lasts:** it ends with the launch, or when the operator clears it.
- **How it shows:** `reasons[]` keeps the base verdict and the narrowing side by side (for example
  `base:AVAILABLE`, `operator-narrowed:UNKNOWN`), so neither fact is lost.

ProjectManager and Architect sessions cannot narrow. They coordinate through dispatch (once typed
dispatch exists, §4) and through control holds, which compose to `HELD`.

### 8. Transcript parsing is banned as a source of workload or clearance

No code path may derive `state`, `clearance`, `availability` or any `composed` field from pane text,
transcript files or captured output. That includes this repository's own `STATE`, `RUNNING`,
`COMPLETE`, `SAFE TO CLEAR` and `DO NOT CLEAR` lines. Pane reads remain allowed for exactly one
purpose: the observer's engine-activity assessment (§5). That input can only *downgrade* a verdict
(rules 5 and 11), never assert one.

Enforcement:

- A test scans `lib/`, `server.js` and `public/` and fails on any pattern that matches those clearance
  phrases outside tests and prose.
- The composition function takes no pane text as input, so this is enforced by its signature, not
  only by review.

The agent-facing guidance (the injected operational guide and the session prime) tells a session to
run `tc workload set` wherever it would write one of those lines. The visible lines stay a courtesy
to a human reader, not a contract.

### 9. When a session emits, and what the server does without it

The guidance asks for a `tc workload set` at:

- dispatch acceptance
- each meaningful task transition
- the start of any external wait (CI, review, operator input, merge)
- completion
- before wrap
- before an intentional exit
- again before the state's expiry, when the state still holds

The server never synthesizes a receipt. It records only the lifecycle and supersession events in §4,
so a session that stops reporting composes to `UNKNOWN` rather than to whatever it last said.

### 10. Surfaces read one composition

- **The fleet read:** `GET /api/tc/sessions` adds `engine`, `workload` and `composed` per lane, from
  SQLite plus the observer's in-memory cache. The route keeps its current property of running no
  tmux capture or probe per request.
- **Its consumers:** `tc sessions`, `tc workload show`, and the dashboard / Master fleet views render
  that same response. None re-derives the composition, which lives in one module (ADR 0001).

## Consequences

- **A lane is `AVAILABLE` only on two independent kinds of evidence:** its own current assertion, and
  fresh, strict observed engine rest. That removes the two misclassifications in #1912: a CI-waiting
  lane composes `WAITING`, and a free lane that says so composes `AVAILABLE`.
- **A silent lane reads `UNKNOWN`,** and so does any lane whose assertion has expired, including
  `complete` after 120 minutes. Coordinators must treat `UNKNOWN` as "ask", not "assign". That is
  more friction than today's guessing, and it is honest.
- **A new background observer costs CPU,** bounded at one serial capture per live session per 10 s
  tick and 3 s of wall time per tick. When the budget is exceeded, observations go stale and read
  `unknown`. The budget is never raised to keep up.
- **Dispatch supersession waits on typed dispatch.** Until a durable, lane-bound assignment-dispatch
  event exists, a new assignment does not immediately end the previous receipt. The expiries bound
  how long that can mislead: 30 minutes for `working`, 120 for the rest.
- **Receipt writing is new work for every session.** Until the guidance lands and sessions adopt it,
  most lanes compose `UNKNOWN`. The rollout is additive: nothing that exists changes meaning.
- **`resolveAccess` grows two return fields** (`sessionId`, `launchId`). Every existing caller ignores
  them, and its refusal semantics are unchanged.
- **Schema v50 adds one append-only table,** unique on `(launch_id, seq)`. At most one receipt per
  second per live launch, it stays small; a retention sweep is deferred until it is measured.
- **The expiry values are a judgment call,** ratified in FWV-A17. They will be wrong for some tasks.
  A lane that outlives its window re-asserts; it is never silently trusted.

## Rejected alternatives

- **Parse the pane's STATE / SAFE TO CLEAR lines.** They are free-form, spoofable by any text an agent
  prints or quotes, and not bound to a launch. A16 bans it, and §8 makes the ban structural.
- **Let the caller supply session id, launch id, assignment id, sequence or timestamps.** Every
  identity field would then be a claim. The awareness-receipt path shows the cost: it keys on the
  claimed project and cannot prove who wrote it.
- **Reuse the awareness receipts or the READY attestation.** The first is not launch-verified and
  records verb calls, not work. The second is write-once initialization. Stretching either would
  change what existing readers believe.
- **Use the wake monitor as the activity source.** It stops at no-mail and probes only for a pending
  wake, so most lanes would have no observation. Driving it for the fleet would couple wake delivery
  to capacity reporting.
- **Capture panes synchronously on the fleet read.** One read would cost one capture per live session,
  and its latency would grow with the fleet.
- **Supersede on every Medusa delivery.** Acknowledgements, review results and coordination are not
  work assignments, and a lane would read `UNKNOWN` after every message it received.
- **Treat pane idleness as availability.** It is exactly the #1912 failure: a pane at its prompt
  waiting on CI looks idle.
- **Let an operator override precede engine observation.** An override could then hide a lane that
  is visibly working. Narrowing is applied last, and it cannot mask `WORKING`.
- **Let PM or Architect sessions set another lane's workload.** That is a claim about someone else's
  work. Dispatch and control holds are the coordinators' levers, and neither can make a lane look free.
- **Carry a receipt across launches** (for example, so a relaunched session is available at once). A
  new launch is a new context. Its availability must be asserted afresh.

## Implementation sequence (non-normative, for the train plan after approval)

1. **Receipts:** `workload_receipts` (v50) with `UNIQUE (launch_id, seq)` and transactional sequence
   allocation. `resolveAccess` returns `sessionId`/`launchId`. `POST /api/tc/workload` with the
   §2–§3 validation and `assignment_id` stamping. `tc workload set/show`.
2. **The activity observer (§5),** with its budget, the strict at-rest gate, the freshness contract,
   and tests for starvation and stale-to-`unknown`.
3. **The composition module (§6–§7)** with the control and wrap supersession events (§4), surfaced on
   `GET /api/tc/sessions` and `tc sessions`. The six #1912 acceptance cases are tests here.
4. **Guidance and enforcement:** operator narrowing, the transcript-parsing guard test (§8), and the
   injected guidance (§9).
5. **Views:** dashboard and Master fleet views reading the same response (§10).
6. **Dependency, sequenced separately:** typed assignment-dispatch, and dispatch supersession once it
   exists.
