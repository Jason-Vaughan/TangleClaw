# ADR 0023: The Discord operator bridge is Master-mediated — a durable gateway carries the message, the Master session routes it, and neither is authority

**Status:** Accepted for architecture only (2026-10-04, Architect contract re-review). That
acceptance has three limits:

- **It does not activate cutover.** The interim procedure stays in force (Decision 10).
- **It does not authorize merging an implementation.** Implementation needs its own exact-head
  security review and live-verification gates.
- **It assigns no schema number** and contains no DDL or router code.

The "Records that carry the decision" section is this ADR's own proposal. It is not ruled.
**Rulings recorded:**

- the initial ruling of 2026-10-04, in the body of #2031;
- the contract review D1 to D7, in
  [this comment on #2031](https://github.com/Jason-Vaughan/TangleClaw/issues/2031#issuecomment-5977128818),
  which is canonical for them;
- the contract re-review R1 to R6 and its retention rule, in
  [this comment on #2031](https://github.com/Jason-Vaughan/TangleClaw/issues/2031#issuecomment-5977193728),
  which is canonical for them.

Where this ADR and a recorded ruling differ, the ruling wins.
**Source issue:** #2031, the schema and Master-router reconciliation gate for the Discord stack.
**Related:** #1956 (server-side channel), #1799 (notifications and helper), #2040 (the interim
procedure, documented in [`docs/discord-operator-notifications.md`](../discord-operator-notifications.md)),
#2005 (failed deliveries are never reported back), #2037 (durable decision routing).
**Builds on:** ADR 0008 (the Project Master), the Medusa exchange record in
[`docs/medusa-delivery.md`](../medusa-delivery.md).
**Supersedes:** the direct-`targetProject` routing design of PRs #1966, #2001 and #2003.

**On the labels and the number.** The contract review is cited as D1 to D7 and the re-review as
R1 to R6. The initial ruling carries no letter. An earlier draft of this ADR
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
inbound    Discord ──▶ helper ──▶ gateway ──▶ Master session ──▶ target session
                                     │        (decides the route)        ▲
                                     └────── mechanical routes ──────────┘

outbound   target session ──▶ gateway ──▶ Master session ──▶ gateway ──▶ helper ──▶ Discord
                              (reply held)  (releases it)
```

1. The **helper** authenticates to Discord, applies the allowlist, and durably delivers the
   operator's inbound conversation to the **Master gateway**.
2. **Master resolves the destination**: the one the operator explicitly addressed, or the default.
3. A **correlated, tracked Medusa message** goes to the target session.
4. The **correlated reply** comes back to the gateway.
5. The **operator-notification and filter policy** is applied. Master releases the answer
   (Decision 16).
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

> **Superseded in part by Decision 9a (operator ruling, 2026-10-05).** What this section lets
> the gateway "apply mechanically" it now only suggests: a reply, a pin, an exact alias and the
> default are recorded for the Master, and the Master's route write is what sends a message.
> The order of the steps and the default are unchanged. The text below is kept as decided.

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
2. one of the four authoritative typed server notifications (Decision 9, as amended
   2026-10-10);
3. a delivery failure;
4. a Master-approved `milestone` or `operator-action-required` item, bound to its source
   receipts.

**Clarification (Architect, 2026-10-04).** The one notice Decision 17 permits, and the "queued,
Master unavailable" notice of Decision 4, are not a fifth kind of content. They are transport
control: a `status` item whose text is a fixed sentence the server wrote, tied to its route,
idempotent, and at most one per route. It cannot carry prose from the operator, a session or
Master, and it is not a delivery failure.

The fourth is the candidate lane the operator relies on today. A verified session may submit
candidate milestone or operator-action-required facts to Master. Only Master may validate them,
consolidate them and render them into gateway outbound items. It is not a way for a session to
send prose to Discord.

### 9. Which server notifications ship first (D6)

`operator-needed`, `work-blocked` and `fleet-idle`. `release-action-needed` and
`certification-state-changed` stay reserved until an authoritative producer exists for each.

**Amended (operator ruling, 2026-10-10, on #2262): a fourth type, `lane-silent`.** A lane whose
workload report expired is nudged once, and when the nudge goes unanswered its coordinator is
told over the switchboard (`docs/fleet-workload.md`). Where there is no coordinator to tell, or
the message to it could not be delivered, the escalation is recorded for the operator and until
now reached nobody. The operator ruled that this record is to reach them as a typed server
notification, not as a candidate a session submits and not as a session's own send.

- **Its authoritative producer** is the server's record of that escalation: a
  `workload_nudge_facts` row of kind `escalated` on the `operator` route. The notification is
  bound to that row, one per row, as `work-blocked` is bound to its workload receipt.
- **It is transport control like the other three:** a fixed template that takes only what the
  server resolved, never text a session or the operator typed.
- **It keeps for 7 days,** as `work-blocked` and `operator-needed` do (Decision 20's limits):
  a lane nobody has heard from is still so until somebody acts.
- **Admitted before it is produced.** The types are a closed list held in three places: this
  Decision, the CHECK on `bridge_outbound.notify_type` (schema v62) and the retention limits.
  A test keeps the last two equal. Schema v62 admitted the type one change ahead of its
  producer, the pass in `lib/bridge-notify.js` that raises one notice per operator-route
  escalation in `workload_nudge_facts`; a test holds that every admitted type has a template.

**Amended (2026-10-11, on #2272): a fifth and a sixth type, `gateway-down` and
`gateway-recovered`.** The chat helper can lose its connection to Discord's Gateway and go on
posting: the operator's messages then reach nobody, and nothing told them. The operator ruled
(2026-10-10) that the server queues a notice once the helper has had no connection for five
minutes, and announces the recovery once.

- **Two types, not one.** A notice that the connection is gone asks something of the operator
  when Discord has refused it. A notice that it is back asks nothing. The type is what a reader
  filters by, so each has its own.
- **Their authoritative producer is** the helper's own report of its connection, which it
  sends with every claim and the server holds (`docs/operator-bridge.md`, "The helper's
  Discord connection").
- **They are transport control like the others:** fixed templates that take only a time, a
  whole number of minutes, a state from the helper's closed list and Discord's close code. A
  connection Discord refused is said to be refused, with the reason, and that it will not come
  back by itself; it is never worded as one being retried. Times are the host's local time
  with its zone, and UTC, said as UTC, where the zone cannot be named.
- **`gateway-down` keeps for 7 days,** because it is still so until the connection is back.
  **`gateway-recovered` keeps for 1 day,** as `fleet-idle` does: it describes a moment.
- **Admitted before they were produced,** as `lane-silent` was. Schema v63 widens the CHECK on
  `bridge_outbound.notify_type`, the retention limits name both and each has its template.
- **Raised by the pass in `lib/bridge-notify.js`,** from that report. One outage runs from its
  notice to the next report that says connected, and the notice in the queue is its record, so
  neither a helper restart nor a server restart announces it twice. A report that is missing
  or stale neither opens an outage nor closes one. `docs/operator-bridge.md`, "Server
  notifications", has the rules in full.

The two reserved types stay reserved.

### 9a. The Master routes inbound as well (operator ruling, 2026-10-05)

Decision 2 made the Master the sole semantic filter and router, and the first build applied
that to what goes out: nothing is posted until the Master releases it. Inbound was routed by
fixed rules: an `@name`, a reply, a pin or the default sent a message to a project session with
no Master judgement in between. The operator has ruled that out.

- **Every inbound waits for the Master's explicit route write.** `@name`, reply inheritance, a
  pin and the default are suggestions shown to the Master. None of them dispatches.
- **No exception for the Master's own messages.** A message for the Master is routed
  `--to master` and then answered. Answering straight from `awaiting-master` stays refused.
- **Cost, accepted:** one Master turn per message, and no inbound moves while the Master is
  away. The route waits, the operator gets the existing "still waiting" notice, and the existing
  notice when the Master cannot be summoned.
- **Not chosen:** delaying activation until the helper runs as its own macOS user. The operator
  accepts, for v5.31, that the helper's secrets are readable by any process of the same user,
  with the Master in the loop for every inbound, the advisory fence disclosed, and a bot role
  limited to the one allowlisted private channel. Separate-user isolation is future work.
- **The Master may ask before it decides** (operator ruling, 2026-10-05). A question about a
  held message is posted to the operator and changes nothing else: the message stays held and
  nothing is dispatched. Only an operator reply recorded as a reply to that very question can
  be adopted as its answer, once, with the route decision it supports. A denial, a timeout, an
  unrelated or a second reply grants nothing. A question that runs out closes nothing.
- **A stopped session is never launched automatically** (operator ruling, 2026-10-05). The
  Master asks, in the server's fixed words, and records the operator's correlated yes; the
  server launches, and the Master never calls a launch route. Limits as ruled: the question
  can be answered for 60 minutes; one launch is in flight on the install, the rest in the
  order consent was adopted; a held or stopped lane refuses; the session has 10 minutes to be
  READY and to be the session that was launched, with the server's own listener for it; then
  the original is sent on unchanged. A failure is told and never retried, no other target is
  tried, and the bridge never ends a session.
- **Reachability is automatic and bounded** (operator ruling, 2026-10-05). No project is
  connected by hand: every project in the registry that is not archived, is inside the
  Master's scope and is not opted out is reachable, worked out as it is asked and cached
  nowhere. Nicknames are overlays on project ids, never the source of reachability. The scope
  fails closed: an unresolvable one reaches nothing, and is said and audited. Opt-out is the
  signed-in operator's alone. Two live sessions of one project are never guessed between. No
  session is designated primary in v5.31.
- **Nicknames are managed in conversation** (operator ruling, 2026-10-05), through the reserved
  `@master`: remember, list, explain, rename, forget. The dashboard is for inspection and
  recovery. A nickname is low-risk routing metadata: it names exactly one destination, is only
  ever a suggestion, and grants no authority. The Master stores one only with an operator
  message behind it. An explicit instruction is its own confirmation only when its target is
  exact and unique, the name collides with nothing, and that message has authorised no other
  change; otherwise the Master asks, and the operator's correlated reply is what authorises it.
  The authority is the `@master` message's and no other's (Architect ruling, 2026-10-05): the
  instruction must be one the operator addressed to `@master` and the Master routed to itself,
  and a reply authorises a change only when its question was about such a message. A message
  addressed to a project acquires none by being asked about. A change made on a reply is one
  transaction: it proves the address record, the correlation, the question's purpose and
  standing and single use, routes the `@master` message to the Master as the Master's
  decision, makes exactly one change, settles the question and closes the reply's route. All
  of it or none; a message that cannot be routed to the Master as it stands is refused and
  nothing is consumed.

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
- **A rollback edits no rule (Architect ruling, 2026-10-04).** The rule that replaces Rule #145
  carries its own fallback: while the bridge is rolled back and disabled, and only until it is
  enabled again, the Architect alone may post milestones and operator-needed notices by the
  former direct route, with the token read from the Keychain through standard input and every
  post verified by reading it back. No other session posts and nothing is sent both ways. This
  is an emergency path, not the delivery design: the alternative rejected below, the Architect
  as the standing fallback, stays rejected. It exists so that the operator can still be reached
  without a rule being rewritten in the middle of an incident. Activation confirms the clause
  is in the replacement text before the rule is replaced.
- **Rule #128** is the older Discord rule, concurrently active though superseded by Rule #145.
  This ADR and its PR edit neither. At cutover, once the replacement rule is active under its
  own newly assigned number, the operator disables the legacy Rules #145 and #128 and keeps both
  for audit. A rollback leaves the new rule active and uses its own fallback for a disabled
  bridge; it re-enables neither legacy rule.
- **Rolling the bridge back keeps v5.31.0 and its store (Architect ruling, 2026-10-04).** Putting
  back the previous build and the pre-update snapshot is a separate emergency procedure, for
  when v5.31.0 itself cannot start or stay healthy. It is a rollback in time: everything written
  after the snapshot is absent from the active store, and the v5.31 store is quarantined, never
  deleted and never merged back. It needs the Operator's explicit agreement and the Architect
  present, and it proceeds only once the server job is proven gone and nothing has the store or
  its sidecar files open.

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

### 14. The Master principal (R1)

- **A first-class logical `master` principal.**
- **Its credential is generation-bound**, minted on `ensure`, and scoped only to bridge-routing
  operations.
- **The server holds verification material only.**
- **The credential is injected at launch.** It never appears in a command's arguments, in a log,
  in a tracked file, or in the writable Master home.
- **It is rotated or revoked on restart and on kill.**
- **Every decision records a distinct verified proof** (for example `master-launch`) and the
  Master generation.
- **This is a narrow slice of #966.** It is not a general fleet-mutation token, and it is not
  gated on finishing #966.

### 15. How Master hands a decision to the gateway (R2)

A structured `tc bridge` surface, backed by scoped server routes. Free-form Medusa prose is not
the surface, and the gateway never parses model prose as a routing command.

The initial operations:

- list and read pending routes;
- route or delegate, naming the route id, the expected version and the exact destination;
- answer, or release an outbound item;
- submit a receipt-bound candidate notification;
- close a route.

Every write is idempotent, version-checked and audited.

### 16. Master answers the operator (R3)

- **A target's verified, correlated reply lands durably at the gateway** and waits there for
  Master's editorial release.
- **Master is the party that answers the operator**, using the target's reply as its source.
  Nothing from a target goes straight to the helper or to Discord.
- **If Master is unavailable, the reply stays queued** and Master is ensured or woken.
- **When Master is itself the target, it answers through the same release path.**

### 17. The escalation cap (R4)

- **The helper acknowledges at once** that the message was durably received.
- **After 5 minutes with no final answer:** at most one pending notice to Discord, and one wake
  or notice to Master.
- **It never climbs** to the `blocking`, `critical` or operator-authority rungs.
- **The pending notice is a `status` item** (see Decision 8's clarification): fixed text, one
  record, one helper acknowledgement, never repeated. A route that has already had the
  "Master unavailable" notice has had its one.
- **A terminal delivery failure may produce one immediate failure notice.**
- **Nothing repeats.** The route stays open until Decision 7's close condition.

This is policy local to a route. It does not change the Medusa watchdog's global defaults.

**How it is held, since #2086 (Architect ruling, 2026-10-04).** The gateway's message to a
project is a normal-priority Medusa exchange, and when this Decision was written normal mail
never reached the operator. #2086 gave it an operator rung. Left alone, the bridge's own send
would have been raised after an hour and reported to the operator as a second notice, about the
bridge's own message. Three things hold the cap now:

- **The gateway owns the exchanges it sends, and says so.** A send is the gateway's when it has
  verified system provenance, the gateway's listener as its sender, and a request id the gateway
  makes. The watchdog does not raise such a send, at normal priority, to any rung; a blocking or
  critical one is escalated like anyone's. This is not an exemption for
  system mail in general: a system send from anything that has not declared ownership, or
  without all three proofs, is watched like any other message.
- **The exchange stays open while the route waits on it, and no longer.** Open is what lets the
  wake monitor nudge the target and what records a target that retired, so it cannot be closed
  when it is sent. The gateway closes it when the route stops waiting on that attempt, and
  reconciles on every pass, with the bridge enabled or not. An attempt whose outcome is unknown stays open, because its Hub id
  may still bind. The close is in-process, for the declared owner only; who may close an
  exchange over HTTP is unchanged.
- **The bridge does not forward an alert about its own send,** even one recorded before any of
  this was so.

**Winding the bridge down (Architect rulings, 2026-10-04).** Disabling is the kill switch and
withdraws nothing by itself. The rollback's order is: disable; switch the candidate primer off;
stop the helper; revoke the helper token, which ends every lease it held at once; then the
Master closes every open route; then the operator withdraws everything queued that no open
route owns. That last set is what closing routes cannot reach: a candidate nobody decided, a
milestone approved and not yet collected, a server notice, an item set aside. It would wait
through a disabled bridge and be posted when the bridge was next enabled, so the operator's
status lists it, by id, kind, state and age and never its text, and the operator withdraws each
item by its own id. A rollback is finished when the Master's route list and that list are both
empty.

**The stored rules at cutover.** No code rewrites a stored rule. The operator brings the
Master's first hard rule to the shipped sentence without losing a custom rule or the history:
Restore defaults only where every rule is an untouched shipped default, otherwise add the shipped
rule and disable the old one. The Discord rule is replaced the same way: the replacement is
added as a new project rule and is the live rule under its own new number; Rule #145 and Rule
#128 are then disabled and kept for audit. A rollback toggles none of them.

An alert the watchdog raises for an exchange between sessions is a different thing and is meant
to reach the operator through the bridge, as `operator-needed`, once, in words that say why.

**What a disabled bridge still answers (Architect rulings, 2026-10-04).** Disabled means nothing
is sent, started or resolved. It does not mean the bridge cannot be seen or wound down. While
disabled the Master, with its live credential, is still answered on: `status`, with the true
count of open routes; the route list and the read of one route; `close`; the list of items set
aside and `withdraw`; and the circuit's acknowledgement and reset. The helper is still answered
on `preflight`. The operator's own routes need no bridge to be enabled, with one exception:
switching the candidate primer ON is refused, since it primes nothing while the bridge is off.
Everything else, for
the Master, the helper and a session alike, answers `409 BRIDGE_DISABLED`. The reads are there
because a rollback has the Master close the routes still open, and it cannot close what it
cannot see. The Master's baseline rule says the same: while disabled it may only close routes,
withdraw queued items, and acknowledge or reset the circuit. The list is pinned by a test
derived from the route table, so a route added to it, or taken from it, is a decision.

### 18. Pins and aliases (R5)

> **Superseded in part by Decision 9a (operator ruling, 2026-10-05).** The Master may now store,
> rename and forget a nickname, but only with an operator message behind each change, as 9a
> sets out, and a nickname is routing metadata that grants nothing. What stands unchanged:
> global pins are the operator's alone; exact names and ids come from the registry; the Master
> cannot treat Discord text as authority to change policy. The text below is kept as decided.

- **Persistent global aliases and pins are the operator's alone**, managed through an
  authenticated local UI or CLI, and never through Discord.
- **Exact project names and ids come mechanically from the registry.**
- **Master may create or change only a conversation-scoped pin**, as an audited routing decision
  under its routing capability.
- **Master cannot create a global alias,** and cannot treat Discord text as authorization to
  change policy.

### 19. Consent to start Master (R6)

- **The bridge is disabled by default.**
- **The operator's explicit local enable, or cutover, of the bridge is the consent.** After it,
  an allowlisted inbound Discord message may idempotently ensure and wake Master.
- **Before enablement, an inbound message cannot launch Master.**
- **Ensure attempts are rate-limited and backed off.** They are never a restart loop.

ADR 0008's principle that the operator consents to launching Master is kept. The consent moves
from a click per open to the bridge opt-in.

### 20. Retention (re-review)

- **Route message and reply bodies are kept only while needed** for delivery or review. They are
  cleared after confirmed Discord delivery or close.
- **What remains is bounded:** audit metadata, digests and state.
- **Failures have a bounded retention policy too.**
- **No secret and no body appears in routine logs.**

### 21. How the helper collects and acknowledges (Architect rulings, 2026-10-04)

Decision 11 keeps "an outbound item is acknowledged only after Discord confirms the post", and
Decision 20 bounds how long an item may wait. Together they left a hole: a helper that had
fetched an item and posted it just as the item's limit passed could not acknowledge it, because
nothing recorded the fetch. These rulings close it.

- **Collecting is a claim, not a read.** The helper has no way to read the mailbox without
  claiming from it. Each item is handed over under a **lease**: its own id, the item, the helper
  token it was issued to, when it was issued and when it lapses. The window is short.
- **One live lease per item.** A lapsed lease returns its item to the next claim.
- **A claim is token-bound and idempotent on its nonce.** An exact repeat returns the same
  leases and issues nothing; the same nonce with a different request or token conflicts.
- **Every write about an item is bound first.** The active token is authenticated, and the
  exact token, lease and item binding is checked, before anything about the item is revealed.
  A caller that does not hold the lease gets the same refusal whether the item is waiting,
  delivered, set aside or let go: there is no oracle on an item's state. (A first
  implementation answered the item's state before the lease, so that a helper would not ask
  forever once its lease was pruned. The Architect rejected that ordering.)
- **A lapsed lease is not bound merely because the same token once held it.** Any expired,
  replaced, revoked or otherwise non-live lease gets the same non-oracular `LEASE_LAPSED` or
  binding refusal on every route, and learns no delivered, blocked, withdrawn or nonexistent
  state. (This retires `OUTBOUND_EXPIRED`, `OUTBOUND_DELIVERED` and `OUTBOUND_BLOCKED` from the
  helper's routes, and with them the earlier "a late acknowledgement is refused
  `OUTBOUND_EXPIRED`": it is refused `LEASE_LAPSED`, and the item stays let go.)
- **The sole exception is a minimal, immutable completion receipt:** the exact lease that
  sealed the complete ordered delivery may replay that acknowledgement, while its token remains
  authorised. It is exposed through the acknowledgement's idempotency alone, not as state on
  the part or failure routes. That lease is kept for as long as the item is, so lease pruning
  never leaves a valid helper asking forever. Every other old lease fails uniformly. A claim
  repeated under its nonce is held to the same rule: a lease that is no longer live comes back
  as its id and state alone.
- **A hand-over is counted.** `attempts` rises by one for each lease issued for an item, and
  never for a claim repeated under its nonce.
- **A live lease is the one thing that holds an item past its retention limit,** and no lease
  is issued for an item already past it. So an acknowledgement can cross the limit by at most
  the lease window. Without a live lease, being let go stays final.
- **A lease bounds how long the helper may hold an item; it does not make a post safe to
  repeat.** That is the helper's own record and Discord's nonce. A post whose outcome cannot be
  known, or that Discord rejects, is held for the operator to settle and is never retried by
  itself.

The detail is in `docs/operator-bridge.md` ("Claims and leases") and
`docs/operator-bridge-helper.md`.

### 22. What a reply answers (Architect ruling, 2026-10-04)

The operator must be able to reply to a posted milestone, from any part of a long post, and
have the reply reach the Master as a reply to that milestone.

- **Every delivered message is mapped to its item.** The acknowledgement reports the complete
  ordered set of the chat's message ids with their count. The bridge records each against the
  item and derives what the item was (route, candidate, type) from the item itself. The first
  id remains the item's reference. A partial or malformed set delivers nothing; an exact repeat
  changes nothing; a different set, or an id the bridge already knows as another message,
  conflicts.
- **Each part is recorded the moment it is posted,** through a token- and lease-bound,
  idempotent part receipt, and the acknowledgement seals only a complete ordered set. After a
  crash, a lapsed lease or a new claim, the claim returns the parts already posted, so the
  helper resumes with the remaining parts and posts none twice, and a reply to any part already
  posted resolves durably.
- **A reply to any mapped message resolves deterministically.** An item with a route keeps the
  existing behaviour: the reply goes where that route went. An item with no route (a milestone,
  another candidate, a notification) sends the reply to the verified Master as an explicitly
  correlated operator reply, with immutable context naming the outbound item, the candidate id
  and kind, the message replied to, the item's first message, and the part's index and count.
  It is not unaddressed input, and it neither changes nor re-releases the candidate. A
  reference the bridge does not know stays on the existing unaddressed path.
- **The resolution is named for what supplied it.** A reply that follows a live route keeps
  `reply-inheritance`. When the durable record of a posted part supplies the correlation
  instead (an item with no route, or an answer whose route was legitimately removed), the
  resolution is `outbound-correlation` and the destination is the verified Master: never the
  default, never unaddressed, never a session directly.
- **An explicit `@name` takes precedence only when it resolves to exactly one current
  destination,** and the Master remains the broker. The reply context is kept either way. A
  name that is ambiguous, unknown or stale is a typed refusal to resolve
  (`address-ambiguous`, `address-unresolved`, or `address-out-of-reach` since Decision 9a's
  reachability rule) that waits for the Master; it is never silently
  diverted or defaulted.
- **The mapping lasts as long as a reply may arrive,** which is without limit, so it is never
  removed. It holds ids and no text. This is the one record Decision 20's retention does not
  bound, and it is bounded in size by what was posted.
- **Nothing here gives a session a path to the chat or the chat a path to a session.** The
  reply reaches the Master through the gateway's route, like any other operator message.

### 23. An item the helper cannot post (Architect ruling, 2026-10-04)

- **The helper has no destructive authority.** It cannot discard an item.
- **It reports a failure,** bound to its token and lease, with a reason from a closed list and
  the ids of any parts that did post. A transient or unknown failure leaves the item
  retryable. A permanent or configuration failure **blocks** the item and raises
  `operator-needed`, until the Master or the operator explicitly requeues or closes it.
- **A failure of the chat itself opens one circuit, not a pile.** A closed, channel-level
  configuration failure (the channel or server verified missing, permission denied, the bot's
  token refused) atomically blocks the item in hand, opens one durable configuration episode,
  raises exactly one `operator-needed` record for that episode, and stops all further claims.
  Later polls get one typed `BRIDGE_CONFIGURATION_BLOCKED` answer and neither change queued
  items nor raise more notices. Recovery is a verified Master or operator reset after the
  configuration is fixed, which closes the episode and explicitly requeues or withdraws what
  was blocked. Nothing clears it by time alone.
- **Only the chat's own verdict opens it.** An item-specific permanent refusal blocks only that
  item. A transient, network, rate-limit or server failure is retried with bounded backoff and
  never opens the circuit.
- **A bare 403 or 404 is neither success nor passed over.** For the fixed-channel
  create-message call: Discord's known configuration codes open the circuit; a 403 with no code
  opens it; a threaded 404 with no code, or Discord's codes for a missing reply target, allow
  exactly one unthreaded retry; a 404 with no code on that retry, or on a post that was
  unthreaded to begin with, opens it. A 403 or 404 carrying a code that is not recognised is
  item-level `outcome-unverifiable`, never the global circuit. An outcome that cannot be placed
  safely fails closed: it is never marked delivered.
- **One closed classifier judges a post attempt,** from whether Discord may have acted, the
  status, Discord's code, whether an earlier attempt is already in doubt, and whether the
  attempt named a message to reply to. The relay acts on its answer and decides nothing itself.
  A definite refusal while an earlier attempt is in doubt becomes `uncertain`: never transient,
  never delivered.
- **`outcome-unverifiable` stays one block reason with two recovery paths.** Held as
  `uncertain` at the helper: settle, then requeue. Absent from the helper's status: nothing
  landed or is held; inspect the refusal, then requeue or withdraw.
- **The Master consumes the episode's record before cutover.** The gateway tells the Master of
  an open episode until the Master acknowledges it, and the Master surfaces it to the operator
  at the workstation. A release made while an episode is open queues and is not a delivery
  receipt. (Phase 4 shipped the record and its status surfaces; the telling and the
  acknowledgement were added in Phase 5.) The acknowledgement is what one Master generation
  knows, not a fact about the episode: a Master launched later is told as one that never
  acknowledged, acknowledges for itself, and only a later generation's acknowledgement
  replaces an earlier one. The telling is bound the same way: the episode records which
  generation was told, a newly live generation is told on the next pass whatever its
  predecessor was told, and the five-minute interval paces only repeats to the same one.
- **The episode's record does not recurse.** It is not delivered through the chat that is
  closed; it is visible through the operator's local status and, until cutover, the interim
  route.
- **A Master close withdraws an undelivered item only when no lease on it is live.** With a
  live lease the close is refused `OUTBOUND_IN_FLIGHT`, so a close that succeeded cannot race a
  post already under way. Delivered items are historical and are not unsent.
- **The helper's lock fails closed.** If the check that a lock's owner is a running helper
  cannot be made, no second helper starts.
- **Retention runs on the gateway's first pass, enabled or not,** and is audited: policy expiry
  is independent of the switch, and a disabled bridge creates no backlog.

The helper's Gateway module is carried over from the helper written for #1799, which never
merged. It is this project's own prior work, not external code. Every carried line is treated
as new and untrusted for review, and it inherits no authority from the contract #1799 was
written against.

## Records that carry the decision (proposed, not ruled)

The rulings fix responsibilities and behavior. This section proposes the records that would carry
them, for the implementation's own review. It contains no DDL and claims no version number.

### P1. One route record per operator message

A route is the gateway's record of one inbound operator message. It holds:

- the external message id (the idempotency key) and the Discord context to answer in;
- how it was resolved: by reply inheritance, pin, exact alias, default, or by the Master session;
- the resolved destination, once there is one;
- the Hub id of each tracked Medusa message sent for it;
- a version, checked on every write (Decision 15);
- its delivery state.

Bodies are held apart from this record so that they can be cleared (Decision 20) while the record
stays.

Proposed states, as a closed vocabulary:

| State | Meaning |
|---|---|
| `accepted` | Stored, not yet resolved |
| `awaiting-master` | Needs the Master session's decision (Decision 3) |
| `queued-master-unavailable` | Master could not be ensured or woken (Decision 4) |
| `routed` | A tracked message is with the destination |
| `reply-held` | The destination's reply is at the gateway, awaiting Master's release (Decision 16) |
| `released` | Master's answer is waiting for the helper |
| `replied` | The answer or a failure has been confirmed posted |
| `closed` | Closed under Decision 7 |

A resolved destination is fixed on the route. A later change to pins, aliases or the default does
not redirect a message that is still waiting.

### P2. Correlation rides on the existing exchange record

The message to the destination is an ordinary tracked exchange in `medusa_exchanges`. No second
correlation mechanism is added.

- **To the session:** the route stores the exchange's Hub id.
- **From the session:** a reply is a Medusa message whose `inReplyTo` names that Hub id.
  `inReplyTo` already requires a verified launch of the right project, so a project's reply is
  provably from the destination the route named. It is held, not posted (Decision 16).
- **A message with no matching route is not a reply.** It can reach Discord only through the
  candidate lane of Decision 8.
- **Delivery failures are facts on the same exchange.** `send_unknown`, `undeliverable` and
  `recipient_retired` are already recorded. Each becomes an outbound failure item, which is the
  gap #2005 names.

Sends for a route are `normal` priority. Priority grants nothing, and a Discord message must not
be able to claim `blocking` or `critical`.

### P3. What the Master principal touches

Decision 14 fixes the principal. Two existing records have to learn about it:

- **The exchange record's `sender_proof` vocabulary** has no value for Master today. It gains
  one, and the Master generation is recorded beside it.
- **ADR 0008** describes Master's API boundary as instructional. A verified, scoped credential
  changes that for bridge routing only, and ADR 0008 needs an amendment when the principal is
  built. The capability gives Master no file-write tier and no general mutation of TangleClaw's
  API.

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
- **A version that never left the branch was revised in place.** Versions 53 and 54 were
  written on the unmerged #2031 stack while `main` stood at 52, so no store outside a test ever
  held either. Later phases of the same stack changed 54's shape under its own number instead
  of adding a version nobody could be upgrading from. That holds only until the stack merges:
  from then on 53 and 54 are shipped versions, and a shipped version is never edited. If `main`
  takes either number first, the stack renumbers before it merges.
- **v54 carries the storage for what the operator ruled on 2026-10-05, ahead of the code that
  uses all of it,** because once v54 ships it cannot be edited and each of these needs rules
  the store itself must hold:
  - `bridge_questions`: what the Master asked about a held message, and how the question stands.
    One open question per message; one use of an operator's reply; a settled question is never
    reopened and its time is never extended.
  - `bridge_launches`: a launch the operator consented to. A row is admitted only on an adopted
    consent for exactly that message, project and reply; one is in flight on the install at a
    time, in the order consent was adopted; a settled launch is final.
  - `bridge_project_optouts`: projects the operator has taken out of reach. The operator's
    alone to write.
  - On `bridge_aliases`: who last changed a nickname, when, and the operator message that
    authorised it when the Master wrote it. A Master write without such a message is refused.
  - A `question` kind of outbound item, so that nothing reasoning about a route's answer has to
    tell an answer from a question.
- **A shipped object is retired by a later version, never erased from the one that made it.**
  v52 created `idx_bridge_routes_conversation` for a lookup that was never written; nothing
  reads it. The upgrade into v54 drops it by name, a fresh v54 store is never given it, and from
  v54 on its presence fails the shape check. v52's own record of what it required is unchanged.
- **Routing adds** the route record of P1, separately clearable bodies, conversation-scoped
  pins, global pins the operator manages and nicknames (Decision 9a), the Master principal's verification material,
  and the audit of every `tc bridge` write.

### P6. Relation to #2037

#2037 wants a blocked session's structured question routed to whoever may answer it. The gateway
is a plausible transport for showing such a question in Discord. Under Decision 6 it cannot carry
an answer to a reserved action. This ADR adds nothing for #2037 and neither blocks the other.

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
- **A target's reply goes straight back to the gateway and out.** One hop shorter. R3 rejects it:
  Master is the only editor of what the operator reads.
- **Master routes by writing Medusa prose to the gateway.** R2 rejects it: the gateway would have
  to parse a model's prose as a command.
- **Sessions post to Discord themselves.** Rejected by every version of this design: the token
  would be reachable from every session, and nothing would apply one policy.

## Consequences

- The operator can address more than one project from one Discord conversation, and an
  unaddressed message has somewhere sensible to go.
- A message is never lost to an unavailable Master. It can wait, and the operator is told so.
- Master gains its first verified identity and its first capability on TangleClaw's API, as a
  narrow slice of #966. ADR 0008 needs an amendment when it is built.
- Once the operator has enabled the bridge, an inbound Discord message can launch the Master
  session without a further click.
- Every answer costs a Master turn, including one a target session wrote. A busy or unavailable
  Master delays answers; it does not lose them.
- The closed stack's code is not a base. Its storage decisions and its safety properties are
  reimplemented; its routing is not.
- The interim procedure remains the only Discord path until both cutover conditions hold, and it
  depends on the Architect session being available.

### Deferred, on purpose (Architect ruling, 2026-10-04)

Accepted for this release and not refactored in Phase 5. None changes behaviour.

- `lib/bridge-api.js` reaches the gateway's `_deps` seam for its clock and for the Master. The
  seam was made for tests; the API using it is a dependency that should be named.
- `verifyHelperToken` spells the `bht_` prefix beside `HELPER_TOKEN_PREFIX` instead of using it.
- The expression that makes a pin id appears twice in `lib/bridge-api.js`.
- `acknowledgeOutbound` still takes a positional `deliveredRef` that only tests pass.
- A route is closed in three places: the Master's close, the gateway's close on delivery, and
  the close that follows a withdrawn answer (`_closeRoutesOfWithdrawnAnswers`). Each writes the
  same columns; one shared function would say so.
