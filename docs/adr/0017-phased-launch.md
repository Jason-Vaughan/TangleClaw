# ADR 0017: Phased launch — a session's context is served, acknowledged and attested, not pushed once

**Status:** **Proposed (2026-09-20).** Written by car 21.12 (#1590) at the close of Train 21, against
a mechanism that is already built and running. It is submitted to the Architect for review before
its PR merges — bound 4 of the train's plan. Cars 21.1–21.10 shipped (v40–v43); car 21.11's
certification half was **cancelled by an operator scope amendment** rather than built — cancelled,
not blocked, and not carried forward — and this ADR says so in § "What was descoped".
**Source issues:** #1579–#1590, tracking #1591. Rulings on #1589 and #1650.
**Builds on:** ADR 0002 (wrap pipeline contract — the handoff publication extends it), ADR 0008
(project/master session model), ADR 0013 (settings take effect or say why not).
**Governing norms:** `.prawduct/artifacts/prime-delivery-direction.md` (ratified 2026-08-31, amended
2026-09-17) and `wrap-direction` §3 — both governance state rather than tracked repo files — plus
this repo's engine-agnostic rule.

---

## Context

A TangleClaw session's context — who it is, what governs it, what state it inherits, what it should
do — was assembled into one prime prompt and pushed into the pane at launch. That design has three
defects, and they compound.

**Nothing confirmed it arrived.** The push was fire-and-forget. A session that never received its
rules and a session that read and ignored them were indistinguishable from the server, and the
operator was the only transport by which the difference could be discovered.

**It had already outgrown its channel.** On Claude Code the prime rides a SessionStart hook with a
10,000-character cap per hook output. Train 21 began with the prime at that ceiling, so every rule,
every shared document and every handoff detail competed for the same budget. The failure mode of
exceeding it is silent truncation — the worst possible one for governance text.

**It could not be engine-agnostic.** Only Claude declares `supportsSilentPrime`/`startupInjection`.
Engines without a hidden channel got the same bytes pasted into a visible composer, which is both
lossy and rude, and paste-only engines had no way to receive rules at all beyond that paste.

The prior state is recorded in the train's plan §1, verified at `39d38348`.

## Decision

**A session's context is rendered once at launch, frozen, and then served to the session in four
ordered steps that the session pulls and acknowledges, ending in an attestation.**

The four steps are `identity`, `governance`, `state`, `task`. The session pulls each with
`tc start next` and acknowledges it by a digest the server issued; when all four are acknowledged it
attests with `tc start ready`. The server owns the order, the content and the verdict.

Five properties carry the design, and each answers one of the defects above.

### 1. Frozen snapshots (B2)

All four steps are rendered at launch and stored as bytes (`launch_sequences`,
`launch_sequence_steps`, migration v40). Every serve returns the stored bytes. A restart, a rule
edit or a change in page budget cannot alter what an already-advertised digest covered. Page
boundaries are computed once and stored with the snapshot for the same reason.

When the rules *do* change before attestation, the snapshot is revised rather than mutated: the
revision increments, steps 2–4 re-render, and the response says `SNAPSHOT_REVISED`. Step 1 carries
its acknowledgement onto the new revision **only when its bytes are byte-equal** — an acknowledgement
never transfers to content the session did not read.

After READY a rule change does not invalidate readiness. The sequence records *initialization*, not
continuous compliance; delivering later rule changes belongs to the existing rules channel.

### 2. An acknowledged pull is delivery (R1)

`prime-delivery-direction.md` §3 requires delivered presence. An acknowledged pull satisfies it: the
session asks for the step, the server serves it, the session returns the digest of what it read.
That is strictly stronger evidence than a push that nothing confirms.

The operator **ratified R1 on 2026-09-17**, and the amendment landed with car 21.6 (#1584) in the same
PR that flipped the `pasteRules` default to `pull` — deliberately recorded before the default it
licenses changed, rather than here in the closing doc car. Its text is in
`.prawduct/artifacts/prime-delivery-direction.md` §3 ("An acknowledged pull is delivery"), which is
governance state rather than a tracked repo file, so it is read from the install and not from a
checkout.

### 3. The sequence is locked, never the pane (R2 — settled, Architect)

Nothing about a launch may block a launch. A sequence that cannot be created, a preflight that
cannot run, an engine that does not support `tc` — none of these stop a pane from starting. The
session gets the pushed prime and `tc start next` explains why there is nothing to serve. The gate
is on the *sequence's* progress, never on the process.

### 4. Identity is a launch-id handshake, not a preallocated row (B6)

`TANGLECLAW_SESSION_ID` cannot be exported into the pane: the session row is allocated after tmux
starts, and a running process never sees a later tmux env change. The alternative — INSERT before
tmux — creates `active` rows for launches that then fail, and mislabels them as `crashed` or forces
a new lifecycle status onto every consumer.

So a 128-bit `TANGLECLAW_LAUNCH_ID` is minted before the environment is built and bound by the same
transaction that writes the session row. The binding exists only if the session does. Before the
bind the server answers `LAUNCH_NOT_BOUND` and `tc` retries for 10 s; if tmux started but the bind
failed, the pane is killed, or the orphan is named.

**The launch id is attribution, not authentication.** It is a local secret in a local pane with
bounded retries and exact project/session validation. Nothing security-bearing rests on it, and
READY inherits the same limit — see § "What READY does not mean".

### 5. The handoff is published in two phases, per attempt (B3, C2)

A wrap stages its handoff document, and publication is bound to lifecycle completion **in the same
transaction** as `store.sessions.wrap`. A crash between the two is repairable only after full
validation, and only for a final or an eligible checkpoint. Every run — a resume included — is a new
attempt with its own identity, so a stale finalize for an older attempt never touches `current.json`.

The next launch's **preflight** reads that state and returns an ordered verdict. `ok` is a positive
predicate: it requires a current, eligible publication from the newest session. Everything else is
named — `crash-recovery`, `handoff-behind`, `legacy-unclean`, `workspace-unavailable`,
`unclassified` and the rest — rather than falling through to a reassuring default.

## Two rulings this ADR is required to carry

### R3 — the recovery default is `operator` (operator, 2026-09-17)

When the preflight says the project's handoff state needs recovering, `operator` mode withholds the
task step and refuses READY until a person clears it from the project's Launch readiness panel;
`advisory` mode serves the task step behind a warning and lets the session clear its own recovery by
attesting with a written reconciliation.

The Architect said no to `advisory` as the default. The operator ruled `operator` — *"for now, until
it's proven there are no issues"* — and reaffirmed it on 2026-09-20 when #1673 asked for the
automatic clear. `advisory` remains a per-project opt-in (`launchSequence.recoveryMode`), built and
tested, so a later switch is a setting change rather than new work.

The refusal ordering in `lib/launch-sequence.js` is load-bearing and worth stating: the recovery
refusal precedes the unacked-steps check, because in `operator` mode the task step is withheld and
the cursor can never reach the end — answering `STEPS_UNACKED` would send the session back to
acknowledge a step nothing will ever serve it. It also precedes the reconciliation check, because in
`operator` mode no text satisfies the gate; an attestation that reconciled its way through would
record a consent nobody gave.

### #1650 — a preflight that could not run must not grant READY

The evaluation-failure ruling (closed 2026-09-20) fixes a verdict inversion: a preflight that failed
to evaluate was treated as permission to proceed, which inverts the chunk's own honesty rule.
`PREFLIGHT_NOT_EVALUATED` is now the single default and it carries `requiresRecovery: true`;
`isUsableResult` validates shape and `needsRecovery` fails closed on a missing or malformed result.
There is **one default and no permissive constructor case**. Failure, absence and "nothing to report"
are three distinct values at every boundary, never one.

This is the general rule the train learned twice — see § "What this design got wrong twice".

## Shipped versus desired

The Architect's ruling on #1589 (2026-09-19) requires this ADR to state the two separately. It is
stated as a table so no row can be read as the other.

| Property | Shipped | Desired |
|---|---|---|
| Four ordered steps, frozen bytes, digest acknowledgement | yes (v40) | — |
| `SNAPSHOT_REVISED` on a rule change; byte-equal-only step-1 carry-over | yes | — |
| `tc start ready` attestation with a server-owned verdict check | yes | — |
| Handoff publication bound to lifecycle completion; per-attempt identity | yes (v41) | — |
| Preflight's ordered verdicts, `ok` as a positive predicate | yes | — |
| Recovery gate, clear route, operator UI control | yes (v43) | — |
| Per-rule drift reconciliation in step 3 | yes (#1588) | — |
| Identity check — **projectId half** | yes, exact | — |
| Identity check — **workspaceId half** | **NO.** `lib/sessions.js` calls `evaluate(project, {workspaceId: null})`, so the comparison in `lib/launch-preflight.js` never fires in production | The launching side needs something stable to compare against. `medusa.mintWorkspaceId` draws fresh random bytes every launch, so comparing it would report `identity-mismatch` on every launch of every Medusa project. **#1611**, open |
| A launch with **no sequence** is gated on a damaged handoff | **NO** — the gate lives on the sequence, so a launch that has none is gated by nothing | **#1623**, open |
| Engine parity **certification** — a pass bound to engine id and version, config fingerprint, runtime identity, launch/session/revision, and assistance attribution | **NO — cancelled by scope**, operator amendment 2026-09-20, because no current downstream consumer needs durable certification. Not blocked, not owed | **None. There is no desired state for this row.** It is not deferred, unscheduled or unowned — it was cancelled. An Architect-ruled design is archived at #1720, and it is history, not a plan. See below |
| Retention for the launch-sequence tables | **NO** — unbounded for Train 21 | **#1595**, open |
| A phased launch for the Master pane | **NO** — Master now declares an honest `{applicable: false, reason}` instead of silence | **#1712**, open question |
| Delegated recovery clearance (a peer clears a stalled session) | **NO** — needs an authenticated non-operator identity path | **#1713**, open question |

## What was descoped, and by whom

**Car 21.11's certification machinery was removed from the train by an operator scope amendment on
2026-09-20**, recorded on #1589. It was **cancelled by scope, not blocked** — the distinction
matters, because a reader who takes it as blocked will go looking for the obstacle and conclude the
work is owed. Nothing in this train certifies automatic engine parity, and nothing in it should be
read as trying and failing to.

**Live parity evidence was not the gap.** The operator accepted **six Codex and three Antigravity
clean READY launches** for this car. The `launch_sequences` table carries attested launches on both
engines independently of this decision. An earlier draft of this ADR said the opposite — that
required probes could not be obtained, because an agent driving a pane is assisted activation and
the Architect had ruled assisted activation cannot certify automatic behaviour. **That reasoning was
retracted**, and it is named here rather than quietly deleted so the retraction survives the draft
that carried it.

What was descoped, precisely:

- **The certification subsystem** — acceptance cases 1–5 and 8. **Cancelled because no current
  downstream consumer needs durable certification**, which is a product judgement the operator is
  entitled to make, not an engineering obstacle. They are neither shipped nor claimed.
- **Aider parity** moved to epic **#1645**, with #1639, #1641, #1643 and #1644 under it. Aider's
  problems were real — a URL-import gate, a per-command output-import confirmation, copy/paste
  fragility, and a model claiming an acknowledgement it had not made — but they are that epic's
  subject now, not this train's.

**The schema collision had a ruled answer, and it was not the reason anything stopped.** The
Architect supplied a viable binding on 2026-09-20 (`.tangleclaw/plans/wrap-sequence-architecture.md`
§3, merged as #1720): a versioned `tc.parity-certification/1` evidence record carried in existing
durable JSON, with a pure resolver over `current`/`stale`/`invalid`/`blocked`/`failed`/`N/A`. The
ruling was **conditional, not an unqualified "no migration needed"** — the existing JSON is the
vehicle *only while it preserves the full binding*, and the ruling's own contingency is to **lift the
no-migration bound explicitly rather than weaken the certification.**

**That design is archived history, not a plan on hold.** It creates no task, no desired state and no
gate, here or on any later train. Nothing inherits it by default: should a real consumer for durable
certification appear, it needs **a newly operator-authorized issue with freshly scoped gates**, and
this ruling is then reference material that new scoping may adopt or discard. Read it at the source
if that day comes.

Acceptance cases 6 and 7 needed no work — #1650 had already shipped the contract, and it was
**verified rather than rebuilt**.

What *did* ship from 21.11 is narrow and honest: the Master pane states `{applicable: false,
reason}` in the same shape a project launch uses, with the reason about the **pane** rather than the
engine — Master usually resolves an engine declaring `launchSequence.supported: true`, so an
engine-derived answer would report "applicable" for exactly the pane where it is least true.
openclaw needed nothing: its reason was already declared in its engine profile.

## What READY does not mean

READY records that the context **arrived and was read**. It is an attestation by a local process in a
local pane, so:

- **It authorizes nothing.** The operator's resume and confirmation rules are untouched by it. A
  session that has attested still waits for its go.
- **It carries no authentication meaning.** Nothing verifies who typed it.
- **It is not continuous compliance.** It is a fact about initialization at one moment.

This is stated in the code, in the prime, and here, because an attestation that reads like
authorization is precisely the failure this train exists to prevent.

## What this design got wrong twice, recorded so it is not re-derived

**Failure, absence and "nothing changed" want to collapse into one value, and the collapsed value is
always the reassuring one.** The train hit this twice, in unrelated code:

1. **The preflight (#1650)** — a preflight that could not run granted READY.
2. **The drift reconciliation (#1588)** — three review rounds, of which two were self-inflicted. The
   first fix split `unmeasured` from `unchanged` and then flattened *which side* was unmeasured; it
   stopped comparing null hashes by demoting whole sources, which dropped measured changes. The shape
   to watch for is **making a value honest at one level and flattening it at the next**.

A null returned by a reader is not a measurement, and two of them must never compare equal.

One more, from the same car and worth its own line: **round 2 shipped a green suite containing a test
that asserted a bug.** Running the suite could never have caught it; only reading the assertion
could.

## Consequences

**Good.** Context delivery is evidenced rather than hoped for. The hook cap stops being a governance
budget. An engine no longer needs a hidden prime channel to receive full context, and one that cannot
receive a sequence says why rather than silently receiving less. A damaged handoff is caught at the
next launch instead of being inherited.

**`tc` on PATH is necessary and not sufficient, and Aider proved it.** The ambient floor puts `tc` in
every pane, but a sequence is only delivered where **the engine integration actually executes `tc`
and gets its output into the model's context** — which is a property of the engine's own interaction
model, not of the PATH. Aider has `tc` and still could not complete an unassisted launch: its URL
import gate, its per-command output-import confirmation and its copy/paste fragility sit between the
command and the model. `launchSequence.supported` therefore records an *intent to serve*, never a
measured capability to consume. Automatic Aider parity is **#1645**.

**Costs, accepted.** A launch now involves several round trips instead of one push. Four tables and
a handoff directory are new storage, with **no retention policy yet** (#1595). The Claude duplication
cost of honest per-channel evidence (plan §2.5) is paid deliberately, and is worth revisiting only if
session-bound per-shard hook receipts ever exist.

**Left open:** #1611, #1623, #1595, #1712, #1713. They are listed in the shipped/desired table rather
than in prose so that none of them can be mistaken for delivered.

**Not left open — cancelled:** engine parity certification. It is absent from that list deliberately.
An item that is cancelled and an item that is pending look identical once both are unbuilt, and the
only thing that tells them apart is where each is written down.

## Alternatives considered

**Keep pushing, but raise the cap.** Does not address confirmation at all, and the cap is the
engine's, not TangleClaw's.

**Preallocate the session row before tmux.** Rejected in § Decision 4: it creates `active` rows for
launches that failed, and fixing the label costs every lifecycle consumer.

**Let the agent self-clear recovery by default.** This is `advisory` mode. The Architect said no as a
*default* and the operator ruled the same way; it remains available per project. The argument for it
— the operator is away most of the time and an `operator` default can stall a launch overnight — is
recorded in the plan's advisory and is not settled by this ADR.
