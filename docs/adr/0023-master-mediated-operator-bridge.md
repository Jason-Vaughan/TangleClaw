# ADR 0023: The Discord operator bridge is Master-mediated — a durable gateway carries the message, the Master session routes it, and neither is authority

**Status:** Proposed. The Decision section records the Architect's rulings and is not open. The
"Contract still to be defined" section is this ADR's own proposal and is not ruled. Nothing here
authorizes DDL, schema or router code.
**Rulings recorded:** the initial ruling of 2026-10-04, in the body of #2031, and the contract
review D1 to D7 of the same day, in
[this comment on #2031](https://github.com/Jason-Vaughan/TangleClaw/issues/2031#issuecomment-5977128818).
That comment is canonical. Where this ADR and the comment differ, the comment wins.
**Source issue:** #2031, the schema and Master-router reconciliation gate for the Discord stack.
**Related:** #1956 (server-side channel), #1799 (notifications and helper), #2040 (the interim
procedure, documented in [`docs/discord-operator-notifications.md`](../discord-operator-notifications.md)),
#2005 (failed deliveries are never reported back), #2037 (durable decision routing).
**Builds on:** ADR 0008 (the Project Master), the Medusa exchange record in
[`docs/medusa-delivery.md`](../medusa-delivery.md).
**Supersedes:** the direct-`targetProject` routing design of PRs #1966, #2001 and #2003.

**On the labels and the number.** Rulings here are cited as D1 to D7. An earlier draft of this ADR
used A-labels. They were dropped because an abandoned draft ADR on two unmerged branches uses A1
to A5 for different, earlier rulings (D5). That draft is numbered 0022. `main` has no ADR 0022 and
will not get that one: the gap between 0021 and 0023 is deliberate provenance, not a missing file.

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
were kept. `main` carries no operator-channel code, no helper and no Discord documentation.

Until the new transport is live, Discord delivery runs on an interim procedure under the
operator's Rule #145: the Architect is the only Discord sender.

## Decision

### 1. The path (initial ruling)

```
Discord ──▶ helper ──▶ Master gateway ──▶ Master session ──▶ target session
                            ▲    │         (routing policy)        │
                            │    └── mechanical routes ────────────┤
Discord ◀── helper ◀── Master gateway ◀────────────────────────────┘
```

1. The **helper** authenticates to Discord, applies the allowlist, and durably delivers the
   operator's inbound conversation to the **Master gateway**.
2. **Master resolves the destination**: the one the operator explicitly addressed, or the default.
3. A **correlated, tracked Medusa message** goes to the target session.
4. The **correlated reply** comes back.
5. The **operator-notification and filter policy** is applied.
6. The result returns **through the helper** to the original Discord context.

### 2. "Master" is two parts with distinct responsibilities (D1)

Master means the Project Master harness session of ADR 0008, supported by a distinct, durable,
server-side Master gateway. The gateway is not Master, and the Master session is not removed from
the routing path.

| | Master gateway (server) | Master session (ADR 0008) |
|---|---|---|
| Kind | Durable server code | A harness session |
| Owns | Authentication and allowlist | Semantic destination resolution |
| | Persistence | Notification and editorial policy |
| | Idempotency | |
| | Correlation | |
| | Mechanical safety | |
| | Delivery state | |

### 3. How a destination is resolved (D1, D2)

- **The default destination is the Project Master itself.** It is not the Architect and not an
  arbitrary project. An unaddressed Discord message reaches Master, and Master answers it or
  delegates it.
- **The gateway may apply these mechanically, under Master's routing policy:**
  - a reply inherits the route of the message it answers;
  - an existing pin;
  - an exact alias;
  - the configured default.
- **Exact addresses and pins may bypass semantic interpretation.** They remain Master-owned
  routing policy, and each use is fully recorded.
- **Anything ambiguous or unresolved is queued as `awaiting-master`.** It is never guessed.

### 4. When Master is not available (D1)

- **On inbound, the gateway ensures and wakes Master.**
- **If Master is unavailable, the message is retained durably** and the operator is told it is
  queued or that Master is unavailable.
- **There is no fallback to the Architect.**

### 5. Master needs a first-class verified identity (D1)

#2031 must create a first-class, verified Master principal or binding, and a narrowly scoped
routing capability for it. A fake or merely stable workspace id is not acceptable, and neither is
a project-launch proof. ADR 0008 gives Master no project and no `sessions` row, so no existing
proof describes it.

### 6. Neither part is authority (initial ruling)

Master coordinates routing and transport. A message that arrived from Discord is conversation. It
cannot approve a merge, a release, a deletion, a credential change or any other action reserved
to the operator, and passing through the gateway or the Master session does not change that.

### 7. Tracking, escalation and closing (D3)

- **Operator messages are tracked and reply-required.**
- **A missing reply is durable and visible.** Normal conversation must not escalate into reserved
  authority or into repeated critical alerts.
- **Escalation is capped and routed to Master.** One honest pending or failure notice to the
  operator is allowed.
- **A route closes only** after the correlated reply or failure has been relayed, or when the
  operator or Master closes it explicitly.

### 8. What may reach Discord (D6)

Four kinds of item, and nothing else:

1. a correlated reply;
2. one of the three authoritative typed server notifications (Decision 9);
3. a delivery failure;
4. a Master-approved `milestone` or `operator-action-required` item, bound to its source
   receipts.

The fourth is the candidate lane the operator relies on today. A verified session may submit
candidate milestone or operator-action-required facts to Master. Only Master may validate them,
consolidate them and render them into gateway outbound items. It is not a way for a session to
send prose to Discord.

### 9. Which server notifications ship first (D6)

`operator-needed`, `work-blocked` and `fleet-idle`. `release-action-needed` and
`certification-state-changed` stay reserved until an authoritative producer exists for each.

### 10. The interim path, and what cutover requires (D4)

- **Rule #145 governs only the interim path, until cutover.** Its text stays unchanged and active
  until the replacement is live and verified. This ADR and its PR do not edit it.
- **Cutover requires both:**
  1. Rule #145 is replaced, with the operator's approval;
  2. the new transport has passed a live round trip and its security verification.
- **After cutover:**
  - Master is the sole semantic filter and router;
  - the gateway enforces fixed mechanical policy;
  - the helper is the sole Discord API sender;
  - the Architect is out of the routine delivery path and keeps architectural and governance
    oversight;
  - no project session posts to Discord directly.
- **Rule #128** is flagged as concurrently active though superseded. A future rule change
  reconciles it. Nothing here touches it.

The two paths are sequential, not parallel. The interim procedure is retired at cutover, not
merged into the new path. #2040 owns its documentation.

### 11. What is preserved unchanged (initial ruling, D7)

- secrets live only in the macOS Keychain;
- exact Discord allowlists (one author, one guild, one channel);
- stable ids and nonces, so a replay cannot create a second message;
- an outbound item is acknowledged only after Discord confirms the post;
- display safety;
- a scoped helper token that is good for the helper's routes and nothing else;
- the conversation-is-not-authority fence;
- no Discord channel or user id is published in a tracked document.

### 12. The superseded work (initial ruling, D5)

- **#1966, #2001 and #2003 do not merge.** They implement direct `targetProject` routing and
  claimed schema versions `main` has since used. All three are closed.
- **The draft ADR 0022 stays unmerged.** It lives on `feat/1799-discord-helper-on-2031-fold` and
  `fix/2031-operator-channel-schema-fold`, and must never land beside this design.
- **Successor code is built fresh from current `main`.** The two branches are read-only
  reference. Parts may be selectively reimplemented after review. They are never used as a base.

### 13. Sequencing (initial ruling)

#2031 (this ADR, then the schema and router model) → #1956 and #1799 → the Discord stack's code,
built for this design → #2040's interim procedure is retired at cutover. #2005 and #2037 are
related follow-ups and are not held by this gate.

## Contract still to be defined (not ruled — for review)

The rulings fix responsibilities. This section proposes the records and rules that would carry
them. It contains no DDL and claims no version number.

### P1. One route record per operator message

A route is the gateway's record of one inbound operator message. It holds:

- the external message id (the idempotency key) and the Discord context to answer in;
- how it was resolved: by reply inheritance, pin, exact alias, default, or by the Master session;
- the resolved destination, once there is one;
- the Hub id of each tracked Medusa message sent for it;
- its delivery state.

Proposed states, as a closed vocabulary:

| State | Meaning |
|---|---|
| `accepted` | Stored, not yet resolved |
| `awaiting-master` | Needs the Master session's decision (Decision 3) |
| `queued-master-unavailable` | Master could not be ensured or woken (Decision 4) |
| `routed` | A tracked message is with the destination |
| `replied` | A correlated reply or failure has been relayed |
| `closed` | Closed under Decision 7 |

A resolved destination is fixed on the route. A later change to pins, aliases or the default does
not redirect a message that is still waiting.

### P2. Correlation rides on the existing exchange record

The message to the destination is an ordinary tracked exchange in `medusa_exchanges`. No second
correlation mechanism is added.

- **To the session:** the route stores the exchange's Hub id.
- **From the session:** a reply is a Medusa message whose `inReplyTo` names that Hub id.
  `inReplyTo` already requires a verified launch of the right project, so a project's reply is
  provably from the destination the route named.
- **A message with no matching route is not a reply.** It can reach Discord only through the
  candidate lane of Decision 8.
- **Delivery failures are facts on the same exchange.** `send_unknown`, `undeliverable` and
  `recipient_retired` are already recorded. Each becomes an outbound failure item, which is the
  gap #2005 names.

Sends for a route are `normal` priority. Priority grants nothing, and a Discord message must not
be able to claim `blocking` or `critical`.

### P3. The Master principal

Decision 5 rules out the two shortcuts. What the principal has to provide:

- **A proof the server verifies**, recorded on every exchange and route decision Master makes. The
  exchange record's `sender_proof` vocabulary has no value for Master today.
- **One capability, scoped to routing**: read a route awaiting it, resolve it to a destination,
  answer it, submit an outbound item for the candidate lane, close a route. Nothing else.
- **No widening of ADR 0008's boundary.** The capability gives Master no file-write tier and no
  general mutation of TangleClaw's API.

ADR 0008 names #966, a scoped API token for Master, as successor work. Whether this principal is
that token or a separate binding is an open question (R1).

### P4. The policy has two gates

- **Inbound fence, in the gateway.** Every message delivered for a route is marked as operator
  conversation, not authority, in a fixed leading line the recipient can rely on.
- **Outbound allowlist, in the gateway.** Only the four kinds of Decision 8 pass. Each is checked
  for display safety, length and rate, and carries a compact source label. Everything else is
  dropped and counted.
- **Editorial judgment, in the Master session.** What a candidate says, whether two candidates
  are one, and whether an item is worth the operator's attention are Master's decisions. The
  gateway does not make them, and Master cannot bypass the gateway's checks.

### P5. Storage shape

Against the schema `main` actually has:

- **One additive migration creates the mailbox in its final shape.** An outbound row has a
  `kind`. An item that did not come from the Hub has its own idempotency key and no Hub id, so
  `hub_id` is nullable and no synthetic id exists. Every insert names its conflict target. The
  whole shape is verified at every startup. This is #2031's original requirement, written fresh.
- **The migration takes the next free number when it lands.** An open PR does not reserve one.
- **Routing adds** the route record of P1, the record of pins and aliases, and the Master
  binding of P3.

### P6. Relation to #2037

#2037 wants a blocked session's structured question routed to whoever may answer it. The gateway
is a plausible transport for showing such a question in Discord. Under Decision 6 it cannot carry
an answer to a reserved action. This ADR adds nothing for #2037 and neither blocks the other.

## Open after the contract review

- **R1. What is the Master principal, concretely?** A token as in #966, a launch-like binding
  minted at `ensure`, or something else. It must survive Master's restart without becoming a
  stable id anyone can claim.
- **R2. How does the Master session hand a decision to the gateway?** The surface of the routing
  capability: a `tc` verb, a route, or Medusa messages to the gateway.
- **R3. When Master delegates, who answers the operator?** Either the target session's reply
  returns to the gateway directly, or it returns to Master, which relays it. The first is one hop
  shorter. The second keeps Master the only editor of what the operator reads.
- **R4. What is the escalation cap?** Decision 7 allows one pending or failure notice. The
  interval before it, and what "capped" means for the watchdog's existing ladder, are not set.
- **R5. Who may create a pin or an alias?** Decision 3 makes them Master-owned policy. Whether the
  operator can set one from Discord, and how that is recorded, is not set.
- **R6. What does "ensure and wake" cost on an idle install?** ADR 0008 launches Master on first
  open so that the operator's click is the consent. An inbound Discord message would now launch
  it too.

## Alternatives considered

- **Direct `targetProject` routing** (the closed stack). Superseded by the initial ruling. It
  reaches one project per channel, and reaching another means reconfiguring the channel.
- **A server gateway alone, with closed rules and no Master session in the path.** This ADR's
  first draft proposed it, to keep an engine out of a path that has to be durable. D1 rejects it:
  the gateway carries the durability, and the Master session keeps the semantic routing and the
  editorial policy.
- **The Architect as router or as fallback.** The interim shape under Rule #145. D1 and D2 reject
  it for the permanent design: it spends Architect turns on transport, and delivery stops
  whenever the Architect is busy or clearing.
- **Sessions post to Discord themselves.** Rejected by every version of this design: the token
  would be reachable from every session, and nothing would apply one policy.

## Consequences

- The operator can address more than one project from one Discord conversation, and an
  unaddressed message has somewhere sensible to go.
- A message is never lost to an unavailable Master. It can wait, and the operator is told so.
- Master gains its first verified identity and its first capability on TangleClaw's API. That
  changes ADR 0008's posture, which today is instructional on the API side, and it needs its own
  amendment there when the principal is built.
- An inbound Discord message can launch the Master session on an install where nobody has opened
  it.
- The closed stack's code is not a base. Its storage decisions and its safety properties are
  reimplemented; its routing is not.
- The interim procedure remains the only Discord path until both cutover conditions hold, and it
  depends on the Architect session being available.
