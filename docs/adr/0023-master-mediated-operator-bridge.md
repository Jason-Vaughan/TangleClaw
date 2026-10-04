# ADR 0023: The Discord operator bridge is Master-mediated — the helper delivers to a Master gateway, and Master routes but never decides

**Status:** Proposed, for contract review. The Decision section records Architect rulings A1 to A3
of 2026-10-04 and is not open. A1 and A2 are recorded on #2031 and its PRs; A3's wording was
relayed by the ProjectManager from the Architect's message. The Proposed contract section is this
ADR's own proposal and is not ruled. Nothing here authorizes schema or
router code; that waits on the review.
**Source issue:** #2031, the schema and Master-router reconciliation gate for the Discord stack.
**Related:** #1956 (server-side channel), #1799 (notifications and helper), #2040 (the interim
procedure, documented in [`docs/discord-operator-notifications.md`](../discord-operator-notifications.md)),
#2005 (failed deliveries are never reported back), #2037 (durable decision routing).
**Builds on:** ADR 0008 (the Project Master), the Medusa exchange record in
[`docs/medusa-delivery.md`](../medusa-delivery.md).
**Supersedes:** the direct-`targetProject` routing design of PRs #1966, #2001 and #2003, and the
"Direct delivery" entry in the forward-extension notes of the operator-channel schema ADR that
exists only on the unmerged fold branches (see "What is superseded").

---

## Context

The Discord Operator Bridge lets the operator leave the workstation and still reach the fleet: a
notification arrives in Discord when TangleClaw needs attention, the operator can write back, and
the answer returns to the same Discord conversation.

It was built as three stacked PRs:

- **#1966** (for #1956): the operator channel, a durable inbound and outbound mailbox on the
  server with a scoped helper token.
- **#2001** (for #1799): typed server notifications in that mailbox.
- **#2003** (for #1799): the Discord helper, a local process that talks to Discord and to the
  channel's routes.

All three routed an operator message to one configured project, `targetProject`. Reaching the
Architect meant setting `targetProject` to the Architect's project. None of the three merged.

Two things changed underneath them:

1. **Schema v51 shipped for something else.** `CURRENT_SCHEMA_VERSION` is 51 on `main` (checked at
   `aa24f20d`, which carries v5.30.0), and v51 is the coordinator rotation tables of #2032. The
   stack had numbered its own migrations v51 and v52. A fold of those two into one migration was
   prepared on the branches `fix/2031-operator-channel-schema-fold` and
   `feat/1799-discord-helper-on-2031-fold`. It never reached `main` either.
2. **The Architect ruled a different architecture** on 2026-10-04. The permanent bridge is
   Master-mediated, not direct-project routing.

On 2026-10-04 the three PRs were closed as superseded. Their branches and the two fold branches
were kept as salvage. `main` carries no operator-channel code, no helper and no Discord
documentation.

Until the new transport is live, Discord delivery runs on an interim procedure under the
operator's Rule #145: the Architect is the only Discord sender.

## Decision

These points are the ruling.

### 1. The path (ruling A1)

```
Discord ──▶ helper ──▶ Master gateway ──▶ target session
                                               │
Discord ◀── helper ◀── Master gateway ◀────────┘
```

1. The **helper** authenticates to Discord, applies the allowlist, and durably delivers the
   operator's inbound conversation to the **Master gateway**.
2. **Master resolves the destination**: the one the operator explicitly addressed, or the default.
3. Master sends a **correlated, tracked Medusa message** to the target session.
4. Master receives the **correlated reply**.
5. Master applies the **operator-notification and filter policy**.
6. The result returns **through the helper** to the original Discord context.

### 2. Master is routing and transport coordination only, never authority (ruling A1)

Master decides where a message goes and whether a reply may be shown. It decides nothing else.
A message that arrived from Discord is conversation. It cannot approve a merge, a release, a
deletion, a credential change or any other action reserved to the operator, and passing through
Master does not change that.

### 3. The direct-routing PRs stay unmerged (ruling A2)

#1966, #2001 and #2003 must not merge and must not be rebased opportunistically. They implement
direct `targetProject` routing, and they claim schema v51 and v52 while `main` already has v51.
#2031 resolves first. All three have since been closed as superseded.

### 4. The interim path stays until the new one is live (ruling A3)

Rule #145 stays in force until the replacement transport is live, and the Architect remains the
sole Discord sender until then. The two are sequential, not parallel: the interim procedure is retired at cutover, not merged
into the new path. #2040 owns its documentation.

### 5. What is preserved unchanged (ruling A3)

The ruling keeps every safety property the closed stack had:

- secrets live only in the macOS Keychain;
- exact Discord allowlists (one author, one guild, one channel);
- stable ids and nonces, so a replay cannot create a second message;
- an outbound item is acknowledged only after Discord confirms the post;
- display safety;
- a scoped helper token that is good for the helper's routes and nothing else;
- the conversation-is-not-authority fence.

### 6. Sequencing

A fourth ruling, A4, set the order of work and is already carried out on the issues. It is
procedure, not architecture:

#2031 (this ADR, then the schema and router model) → #1956 and #1799 → the Discord stack's code,
re-cut for this design → #2040's interim procedure is retired. #2005 and #2037 are related
follow-ups and are not held by this gate.

## What is superseded

- **`targetProject` as the routing mechanism.** One configured project per channel is replaced by
  destination resolution in Master.
- **"Direct delivery" in the fold branches' schema ADR.** That ADR is numbered 0022 on the two
  fold branches and records earlier rulings of 2026-09-30. Its forward-extension notes say an
  explicitly addressed message goes straight to its target's live workspace and not through the
  Architect session. Under this ruling every message goes through the Master gateway. Its other
  forward notes (routing identity by numeric `projectId`, exact aliases, pins, reply inheritance,
  a source label on every answer) are not contradicted by this ruling and are carried into the
  proposal below as inputs, not as rulings of this ADR.
- **The fold ADR's storage decisions are not superseded.** They answer the first half of #2031
  and are re-proposed below.

This ADR takes the number 0023 so that no two documents in the repository's branches are called
ADR 0022. If the fold's ADR is not going to land, review may renumber this one.

## Proposed contract (not ruled — for review)

This is the model #2031 asks for: how a destination is resolved, how a reply is correlated, and
where the policy applies. It names records and rules. It contains no DDL, and no version number
is claimed.

### P1. The Master gateway is server code, not the Master session's judgment

ADR 0008 defines the Project Master as a harness session: an engine in a tmux pane, launched on
first open, with no `sessions` row. Three of the ruling's requirements cannot rest on that pane:

- **Durable delivery.** A message accepted from Discord must survive a server restart and a
  Master session that is not running.
- **Authentication and allowlist.** These are exact checks and must give the same answer every
  time.
- **Idempotency.** The same Discord message id must never produce a second routed message.

So the proposal is that "Master gateway" names a server component that owns the mailbox, the
token check, the allowlist, the route record and the policy. It sends and receives on Medusa under
one stable gateway workspace id, as the closed stack's channel did.

Destination resolution is then a closed, ordered rule set evaluated by that component:

1. A Discord reply inherits the destination of the message it replies to.
2. A pinned destination for this conversation applies.
3. An exact alias prefix applies. Nothing is fuzzy-matched.
4. Otherwise the default destination applies.

Each resolution records which rule fired. A message no rule resolves is refused to the operator
with a short reason. It is never guessed.

This reading keeps a language model out of the delivery path. The alternative reading, in which
the Master session itself reads each message and chooses a destination, is listed under
Alternatives and raised as Q1.

### P2. One route record per operator message

A route is the gateway's record of one inbound operator message. It holds:

- the external message id (the idempotency key) and the Discord context to answer in;
- the resolved destination, as a numeric `projectId`, and the rule that resolved it;
- the Hub id of the tracked Medusa message the gateway sent for it, once the Hub returns one;
- its state.

The destination is fixed when the route is accepted. A later change to pins, aliases or the
default does not redirect a message that is still waiting.

### P3. Correlation rides on the existing exchange record

The gateway's send is an ordinary tracked exchange in `medusa_exchanges`. No second correlation
mechanism is added.

- **Outbound to the session:** the route stores the exchange's Hub id.
- **Reply from the session:** a reply is a Medusa message to the gateway whose `inReplyTo` names
  that Hub id. `inReplyTo` already requires a verified launch of the right project, so a reply is
  provably from the destination the route named. This keeps the spoof guard the closed stack
  added (`sender_verified = 1` and `sender_proof = 'launch'`).
- **A message to the gateway with no matching route is not a reply.** It is refused or held under
  the policy in P4. It is never posted to Discord as if the operator had asked for it.
- **Delivery failures are facts on the same exchange.** `send_unknown`, `undeliverable` and
  `recipient_retired` are already recorded. The gateway turns each into an outbound item for the
  operator, which is the gap #2005 names.

The gateway sends at `normal` priority. Priority grants nothing, and a Discord message must not
be able to claim `blocking` or `critical`.

### P4. The policy has two gates, both in the gateway

- **Inbound fence.** Every message the gateway delivers is marked as operator conversation, not
  authority, in a fixed leading line the recipient can rely on.
- **Outbound filter.** Only three things may reach Discord:
  1. a correlated reply (P3);
  2. a typed server notification from the closed vocabulary #1799 defines, raised by a server
     module that owns the source fact;
  3. a delivery-failure notice for a route (P3).

  Everything else is dropped and counted. Each item that passes is checked for display safety,
  length and rate, and carries a compact source label naming the project it came from.

Sessions do not post to Discord directly, and the helper does not infer events from prose.

### P5. Storage shape

Against the schema `main` actually has:

- **The fold's storage decisions are kept.** One additive migration creates the mailbox in its
  final shape. An outbound row has a `kind`. A notification is keyed by its own idempotency key
  and has no Hub id, so `hub_id` is nullable and no synthetic id exists. A row CHECK ties each
  kind to its key. Every insert names its conflict target. The whole shape is verified at every
  startup.
- **The migration takes the next free number when it lands.** An open PR does not reserve one.
- **What routing adds is additive over that shape:** the resolved destination and resolution rule
  on the inbound side, the source project on the outbound side, and a table for pins.
  `targetProject` stops being configuration and becomes a per-route fact.

Whether the salvage on the fold branches is the starting point for that code is a separate
decision (Q5).

### P6. Relation to #2037

#2037 wants a blocked session's structured question routed to whoever may answer it. The gateway
is a plausible transport for showing such a question in Discord. Under Decision 2 it cannot carry
an answer to a reserved action. This ADR adds nothing for #2037 and neither blocks the other.

## Questions for the contract review

- **Q1. What is "Master" in "Master resolves the destination"?** P1 proposes a server component
  with closed rules. If the ruling means the Master session, then delivery depends on a pane that
  may not be running, and the review needs to say what happens to a message while it is not.
- **Q2. What is the default destination?** The earlier design made it the Architect. The ruling
  does not say.
- **Q3. Does the gateway's send require a reply?** A reply-required exchange stays open and
  climbs the watchdog's escalation ladder when unanswered. That gives the operator an honest
  "no answer yet", and it also means every Discord message opens an exchange some session must
  close.
- **Q4. Who filters, once the transport is replaced?** Rule #145 ends: "replace only the
  transport — the Architect remains the sole filter and sender." Ruling A1 has Master apply the
  operator-notification and filter policy. Either the Architect still validates each candidate
  notification before it enters the gateway and the gateway's filter (P4) is a second, mechanical
  gate, or the gateway's policy replaces the Architect's review. The rule and the ruling do not
  yet say which. Rule #145 also names PR #2003 as the point where the transport is replaced, and
  that PR is closed. Whoever replaces the rule needs to name the PR that actually carries the
  helper. This ADR does not edit the rule.
- **Q5. Is the fold-branch salvage the base for the re-cut code?** It was treated as read-only
  reference for this ADR.
- **Q6. Which notification types ship first?** #1799 lists five and an earlier ruling admitted
  only the three that had an authoritative producer.
- **Q7. Ruling labels collide across documents.** This ADR's A1 to A4 are the rulings of
  2026-10-04. The fold ADR uses A1 to A5 for different rulings of 2026-09-30. A3's wording is not
  on GitHub. Recording it on #2031 would make this ADR checkable from the issue alone.

## Alternatives considered

- **Direct `targetProject` routing** (the closed stack). Superseded by the ruling. It reaches one
  project per channel, and reaching another means reconfiguring the channel.
- **The Architect session as the router** (the interim shape under Rule #145). It works today
  because one session holds the token and posts by hand. It spends Architect turns on transport,
  and delivery stops whenever the Architect is busy or clearing.
- **The Master session reads and routes each message.** One reading of the ruling (Q1). It needs
  no resolution rules, and it puts an engine's availability and judgment inside a path that has
  to be durable and repeatable.
- **Sessions post to Discord themselves.** Rejected by every version of this design: the token
  would be reachable from every session, and nothing would apply one filter policy.

## Consequences

- The operator can address more than one project from one Discord conversation without
  reconfiguring anything.
- One component applies the allowlist, the fence and the outbound filter, so a single place
  answers "why did this reach Discord" and "why did it not".
- The closed stack's helper and mailbox code is not usable as it stands. Its storage decisions
  and its safety properties carry over. Its routing does not.
- The interim procedure remains the only Discord path until cutover, and it depends on the
  Architect session being available.
- Routing adds a record and a pin table to the schema, in a migration that is not yet written.
