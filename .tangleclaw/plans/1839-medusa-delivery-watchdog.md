---
branch: feat/1839-medusa-delivery-watchdog
partition: serial. Every chunk touches lib/store.js, server.js or lib/medusa*.js; chunk 04 needs chunk 03's exchange-state API. Read-only discovery used 2 scouts; B2 remains the sole writer.
---

## Status

*Bookkeeping above the plan body.*

- [x] Plan written (rev 1, 2026-09-25); rev 2 adds Architect R19 (`retracted` terminal state, #1873)
- [x] Architect rulings incorporated: R20 (message `6f9218fb`), rev 3, §0
- [x] Implementation released: R20 released it on incorporation, with B2 as the sole writer. Stops: the governance checkpoint after chunk 02, and the Critic/draft-PR boundary
- [ ] Chunk 01: schema v49 and `lib/medusa-exchanges.js` (state machine, facts, replay)
- [ ] Chunk 02: send-side metadata, validation, arrival, read and ack facts, and the #1435 close-out
- [ ] Chunk 03: wake transport seam, wake facts, and the watchdog timer (fake clock)
- [ ] Chunk 04: escalation routing and surfaces (PM notice, sender and recipient views, operator dashboard, undeliverable recipients)
- [ ] Chunk 05: docs, CHANGELOG, FEATURES, and the isolated-instance E2E
- [ ] Verify: focused tests plus the full suite on the feature worktree (**not** the main instance)
- [ ] Cumulative Critic
- [ ] Draft PR opened. **STOP there**: the PM owns readiness and merge sequencing

# #1839 — Priority-aware Medusa delivery watchdog and escalation (Car B1): plan and design

**Issue:** [#1839](https://github.com/Jason-Vaughan/TangleClaw/issues/1839) (OPEN)
**Train:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/dual-builder-normalization-train.md` → Chunk B, Car B1
**Plan (canonical):** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Pilot-B2/.tangleclaw/plans/1839-medusa-delivery-watchdog.md` · operator link https://cursatory.tail123678.ts.net:8443/plans/96/1839-medusa-delivery-watchdog.md
**Owner:** TangleClaw-Pilot-B2 Builder (project 96, workspace `tangleclaw-pilot-b2-9e788ca6`) · **Baseline:** `origin/main` @ `49a55381`
**Dispatch:** PM message `3ba62ce0` (2026-09-25T18:27:54Z), released to **PLAN WRITTEN only**. #1867 is excluded.
**Status:** PLAN, rev 3 (R19 and R20 incorporated; §0 is binding where it differs from §2–§9). Released for implementation by R20. No branch, commit, push, PR or live mutation has been made. The only local change is a detached read-only worktree, `.claude/worktrees/scout-1839`.

**Requirements Confidence: Medium.** The issue and the Train say clearly *what* must be true. Five design choices (§4) and five smaller points (§8) need rulings. Two facts shape the design and are not in the issue:
- **The Hub carries no metadata.** It accepts exactly `{to, from, message}`.
- **No record names a Builder's PM.** Control authority is a principal matrix, not roles.

Both are covered in §1, and the recommendations in §4 are built around them.

---

## 0. Architect R20 rulings (binding; supersedes anything below that conflicts)

**A1: approved as A1-a, amended.**
- **Append-only facts plus a derived projection, not a rigid total-order FSM.** Arrival, wake, read, ack and reply facts may race or arrive out of order. The `medusa_exchanges` row is a *projection* recomputed from the facts (`replay` must reproduce it). Only the **guarded terminal transitions** (`retracted`, `closed`, and the terminal failures) need atomic winners.
- **Send intent before the Hub.** `/medusa/send` first writes a durable local exchange with its own `exchange_id` and `request_id` and state `send_pending`. It then calls the Hub, and binds the returned Hub id in a **second transaction**. `hub_id` is UNIQUE when present (a partial unique index).
- **`send_unknown`.** The Hub and SQLite cannot be made atomic. A timeout, network error or unparsable response makes the exchange `send_unknown`, which is visible to the sender and **never blindly retried**.
- **Untracked arrivals.** An arrival whose Hub id matches no exchange creates an explicit `untracked` arrival row. Correlation is by Hub id only, never by ordering or body.
- **Close authentication.** Close requires the original verified initiator (launch binding matching the sender project) or audited Operator proof.
- **Close rules.** The recommended rules stand. A reply-required exchange that has been replied to projects as `satisfied`, labelled "awaiting initiator close", and does not escalate.
- **No automatic pruning** in this Car, tombstones included. Retention needs a separately admitted policy. This replaces the 30-day pruning in §4 A1.

**A2: approved as A2-a, amended.**
- A normal *new* send keeps legacy unbound compatibility, but is recorded `sender_verified = 0` (unverified).
- **Every operation that changes or satisfies an existing exchange** requires a verified launch matching the actor, or audited Operator proof. That covers `inReplyTo`, close, and future retract or replacement. The error is `403 EXCHANGE_BINDING_REQUIRED`.
- Blocking requires a verified launch.
- **Critical** is allowed only with `control-auth` Operator proof or an in-process system call. `ambient-open` is recorded honestly as the proof tier.
- Priority grants no control authority.

**A3: approved as A3-a, with the proposed defaults.**
- **Persist each wake attempt, the next-eligible time and the re-arm budget** on the exchange (`rearm_count`, `next_eligible_at`, plus attempt facts), so a restart or duplicate ticks behave deterministically.
- Deadlines are computed from server time. Client input may only shorten a deadline, within bounds.
- A re-arm happens only after a negative receipt or a **persisted** readiness state change, and always goes through the full wake gates. Nothing is injected directly.

**A4: approved as A4-a.**
- Escalation routes are visibility destinations, not new authority. Only the authorized assignment-lifecycle path may set them (operator create, or `authority` change), and principals resolve to their current bound recipients with no nickname inference.
- **An escalation notice records `queued`, `accepted` and `failed` separately.** Hub storage accepting a notice is not "delivered". If a target cannot receive it, record `escalation_undeliverable` and keep the Operator dashboard alert.
- Escalation notices create no child exchanges and never recurse.

**A5: approved as A5-b.** Tmux stays negative-receipt-only, uses a **per-attempt nonce**, and can never claim `accepted`. Every current wake gate is preserved. Native receipt adapters get separate issues.

**P1: rejected as written.** Normal cross-host mail may be recorded `untracked`, with explicit copy. **Blocking and critical to a cross-host or unsupervisable target are refused with `422 WATCHDOG_UNAVAILABLE_REMOTE`** unless the remote advertises a compatible durable exchange/receipt protocol (none does today). A protected priority this host cannot supervise is never accepted.

**P2: approved.** Close #1435 in this PR, with mapped tests.

**P3: approved.** Keep the panel auto-ack and record the actor as `operator-ui`. A reply-required exchange stays **unsatisfied** until a bound reply arrives; the sender must not infer agent compliance.

**P4 and P5: filed** as #1876 (external operator push) and #1875 (the `/send` caller-auth gap). R20 still requires binding for correlated state changes now (A2 above).

**C11 amended.** A listener disconnect or absence from the roster is `queued` or `wake_blocked`, **not** undeliverable: the Hub is allowed to redeliver. Only three things mark an exchange terminally `undeliverable`: durable retirement (the `_teardownMedusa`/`forgetWorkspace` path, which records `recipient_retired`), an invalid target identity (malformed, or unknown to both the Hub and the registry), or an explicit Hub refusal. A reconnect advances the same exchange idempotently.

**R19 split with #1873: approved**, including no route or UI in this Car and non-retractable control records.

**Boundaries.** Implementation is released with B2 as the sole writer. Stop at the governance checkpoint (after chunk 02) and again at the Critic/draft-PR boundary. There is no merge, live or restart authority.

**Test additions from R20** (added to C14): send intent survives a Hub timeout as `send_unknown` and is not retried; hub-id binding in a second transaction; out-of-order facts (a read before the arrival fact, a reply before the ack) project correctly and `replay` matches; an unmatched arrival gives `untracked`; closing as a non-initiator is `403`; an unbound `inReplyTo` is `403 EXCHANGE_BINDING_REQUIRED`; a critical send from a bound project is `403` and from an ambient-open operator is recorded as `ambient-open`; blocking to a cross-host target is `422 WATCHDOG_UNAVAILABLE_REMOTE`; disconnect or roster absence stays non-terminal, and a reconnect advances the same exchange; after a restart mid-backoff, `next_eligible_at` is honored and no duplicate wake occurs; each tmux attempt gets a distinct nonce; an escalation notice the Hub accepted is `accepted`, not delivered, and an unreachable target gives `escalation_undeliverable` with the dashboard alert retained; no fact for an escalation notice creates a child exchange.

---

## 1. What exists today (verified against `origin/main` @ 49a55381)

References use `file#symbol` anchors. Line numbers are omitted because they drift.

| Fact | Evidence |
|---|---|
| **Bodies live only on the external Medusa Hub.** TangleClaw keeps a bounded in-memory inbox per listener (500 entries) and persists no message body. The Hub mints message ids. Mail survives a TC restart only because the Hub redelivers un-ACKed mail on re-register. | `lib/medusa-listener.js` header, `_onNewMessage`; `lib/medusa.js#sendMessage` (`id: data.id`) |
| **The send carries no metadata.** The Hub request body is exactly `{to, from, message}`. There is no priority, reply, thread or conversation field anywhere in `lib/` or `server.js`. | `lib/medusa.js#sendMessage` |
| **`/medusa/send` does not authenticate the caller.** The sender is resolved from the URL project name, and no launch binding is checked. (This was already recorded in the #1861 plan §1.) | `server.js#resolveProjectMedusaTarget`, `registerMedusaRoutes` |
| **`medusa_deliveries` is a wake-nudge ledger, not a message-state ledger.** Its outcomes are `nudged`, `skipped` and `failed`. It records nothing about read, ack, reply or priority, and writes only while `unread > 0`. | `lib/store.js` DDL, `medusaDeliveriesApi` |
| **#1435 is still true.** `markHandled` and `markRead` never touch the store. After a manual read, `unread === 0`, so `record` returns early, and the stale `skipped` row keeps the session in `sessionsWithUndeliveredMail` indefinitely. | `lib/medusa-wake.js` `_judgeSession` → `record`; `lib/store.js#sessionsWithUndeliveredMail` |
| **Opening the UI inbox panel marks every displayed message handled** and ACKs it to the Hub. The wake is bypassed, and nothing records that the agent never saw the message. | `public/api-helper.js#tcCreateMedusaControl` (panel open → `/read {ids: all}`) |
| **The wake monitor** runs a 5 s in-memory tick. It sends one nudge per fresh-mail edge (`lastNudgedKey`), behind these gates: wrap, opt-in, listener state, dedup, engine readiness (#1628), pane busy/agents/idle marker, composer draft, and a 2-tick debounce. After `nudged` it **never** re-attempts that edge. `inject-failed` retries every tick with no backoff. | `lib/medusa-wake.js#_judgeSession`, `assessSessionIdle`, `PEER_REASON_MEANINGS` |
| **The tmux submit has no post-submit check (#1621).** `tmux#sendKeys` pastes, sleeps 500 ms and sends Enter; returning counts as `nudged`. `lib/wrap-delivery-receipt.js` has a *negative-only* receipt (nonce still in the composer → `not-accepted`), and the wrap alone uses it. | `lib/tmux.js#sendKeys`; `lib/wrap-delivery-receipt.js` header ("There is no `accepted`") |
| **No transport interface exists.** The channel is a hard-coded ternary (`master-inject` : `tmux-inject`). The only engine-native adapter is Codex, for startup: `startup-control-codex#fire` has a positive receipt (`clientUserMessageId`). The wake uses that adapter's `observeActivity` for readiness only. | `lib/medusa-wake.js` inject step; `lib/startup-control.js#ADAPTERS` |
| **Readiness `unknown` holds the wake indefinitely**, with no timeout and no escalation (#1628's surfacing criterion). | `lib/medusa-wake.js#_engineActivity` → `engine-thread-unknown` |
| **Teardown discards mail silently (#1806).** Every end path calls `sessions#_teardownMedusa` → `medusa.forgetSession`. The Hub copy is orphaned under a retired workspace id, and nothing records it. | `lib/sessions.js#_teardownMedusa` and its 7 call sites |
| **#1861 control state is live (schema v48).** It has principals `operator`/`project:<id>`, one open assignment per project, an authority matrix `{hold, stop, lifecycle, releaseDelegations}`, and an append-only `control_receipts` table with facts `notify_pending…exchange_closed`, keyed by `notice_ref` (the Hub id). Control notices go out as Medusa system messages, and the wake nudge that carries them is exempt from HOLD (`controlExempt: 'medusa-wake'` in `sessions#injectCommand`). | `lib/control-state.js`, `lib/control-api.js#notify`, `lib/sessions.js#injectCommand` |
| **No PM or Architect role exists anywhere.** The control matrix names principals, not roles, and the launch digest says "TangleClaw has no first-class role or assignment record". | `lib/control-state.js#normalizeAuthority`; `lib/startup-prompt.js` |
| **No operator alert channel exists**: no push, webhook, email or notifications table. The dashboard polls. The closest precedents are the `activity_log` table, the landing-page banners (`public/landing.js`), and `eval-audit#startWatchdog`, whose `onAlert` only logs. | `lib/store.js`; `public/landing.js`; `server.js` eval watchdog wiring |
| **Timer conventions:** a module `_timer` with idempotent `start()` and `stop()`, `unref()`, started in `server.js`'s listen callback, and a `_internal.now` seam for tests. `lib/launch-unready.js` is the house precedent for a one-attempt budget ("It is not a retry loop"). | `lib/medusa-wake.js#start`; `lib/launch-unready.js` |
| **Config:** globals live in `store.js#DEFAULT_CONFIG` with a `PATCH /api/config` `allowedFields` whitelist and per-key range checks. Resolver-with-fallback precedent: `project-config#resolveUnreadyWindow`. | `lib/store.js`; `server.js` `PATCH /api/config`; `lib/project-config.js` |
| **Schema is v48.** An older binary does not refuse a newer database; there is no version-greater check. Additive tables are therefore rollback-safe, but a table *rebuild* is not transparent to an older binary. | `lib/store.js` (`CURRENT_SCHEMA_VERSION = 48`, migration blocks) |

---

## 2. Acceptance criteria → code ownership → tests

The criteria come from the #1839 body and the Train's Car B1 bullets. **New** marks a file or module this Car creates.

| # | Criterion | Owner (code) | Test (all fake-clock; no live Hub) |
|---|---|---|---|
| C1 | Priority `normal` (default), `blocking` and `critical`. `critical` is reserved to the operator and the system. | `server.js` `/medusa/send`; new `lib/medusa-exchanges.js#validateSendMeta` | new `test/medusa-exchanges.test.js`: default normal; blocking accepted from a bound launch; critical from a project is `403 PRIORITY_RESERVED`; critical from a verified operator is accepted; an unknown value is `400 PRIORITY_INVALID` |
| C2 | Reply-required flag and an optional bounded escalation deadline and reason | same | deadline out of `[min,max]` is `400 DEADLINE_OUT_OF_RANGE`; reason outside the enum is `400 REASON_INVALID`; a deadline can only *shorten* the priority default |
| C3 | Priority never grants authority, never bypasses rules, and never permits unsafe injection | `lib/medusa-wake.js` (the gates are unchanged); `lib/medusa-watchdog.js` (**new**) | a blocking or critical message to a busy, drafting or wrapping pane is **not** injected (each gate is asserted); priority does not change `controlExempt`; `control-gate` outcomes are unchanged |
| C4 | Distinct durable states and timestamps: stored/queued, wake pending, wake attempted/blocked/accepted, read/acknowledged, replied/closed | new `medusa_exchanges` and `medusa_exchange_facts` (v49); `lib/medusa-exchanges.js` | the facts chain for each transition; append-only triggers raise; `replay()` rebuilds the cache exactly |
| C5 | Deterministic server timer over durable state; no paid checker agent | new `lib/medusa-watchdog.js` (`start`/`stop`/`tick(now)`) | a tick with an injected `now` crosses each threshold; nothing is injected from the watchdog directly (all wakes go through the wake gates) |
| C6 | At most one idempotent safe wake per message edge; retry only after a state change or a bounded backoff; never a blind Enter | `lib/medusa-wake.js` (re-arm hook); `lib/medusa-watchdog.js#_rearm` | a lost Enter (nonce still in the composer) gives one re-arm, then escalation; duplicate ticks give no second wake; the re-arm budget is exhausted into an escalation, not an infinite loop |
| C7 | Preserve every busy-turn, draft, wrap, identity and dedup gate | `lib/medusa-wake.js` (the re-arm enters `_judgeSession` from the top) | the existing `test/medusa-wake*.test.js` stay green unmodified; new cases re-run every gate on a re-armed edge |
| C8 | Manual handling closes the stuck condition (#1435) | `server.js` `/read`; `lib/medusa-exchanges.js#acknowledge`; the `sessionsWithUndeliveredMail` derivation | skipped, then manual read: the session leaves `/api/medusa/deliveries`, and the exchange is `acknowledged` with actor `recipient` or `operator-ui` |
| C9 | Carry or explicitly fail queued messages at wrap or replacement | `lib/sessions.js#_teardownMedusa` (records `recipient_retired`); the watchdog reports it to the initiator. **Carryover belongs to Car B2 (#1806); see §6.** | wrap-ending with open exchanges gives a `recipient_retired` fact plus a system notice to each initiator; with no initiator (system), the fact is recorded and nothing is sent |
| C10 | Escalate by priority and age: exact blocker on the recipient and sender surfaces; PM notice on a missed `blocking` threshold; operator alert for `critical` or a persistent block | `lib/medusa-watchdog.js#_escalate`; control assignment `escalation` (§4 A4); `public/landing.js` banner; `tc message status` | fake clock: normal gives visibility only; blocking at T1 gives a PM notice; at T2 an operator entry; critical at T0 an operator entry; each notice once per level (idempotent across ticks and restarts) |
| C11 | Undeliverable or retired recipients are reported back to the initiator | `/medusa/send`; `lib/sessions.js#_teardownMedusa`; `lib/medusa-watchdog.js` | **Per R20 C11:** only durable retirement, an invalid target identity or an explicit Hub refusal is terminal `undeliverable`/`recipient_retired`, with an initiator notice. Disconnect and roster absence stay `queued`/`wake_blocked`, and a reconnect advances the same exchange. A normal send to a cross-host peer is `untracked`; a blocking or critical one is `422 WATCHDOG_UNAVAILABLE_REMOTE` (R20 P1) |
| C12 | Replaceable wake transport: receipt-bearing native preferred, guarded tmux as fallback; the durable inbox stays the source of truth | new `lib/wake-transports.js` (interface plus the `tmux` and `master` adapters) | a fake adapter with a positive receipt reaches `wake_accepted`; the tmux adapter tops out at `wake_attempted`, or `wake_not_accepted` on a negative receipt |
| C13 | Reuse A1's control record for HOLD/STOP visibility; no competing authorization system | `lib/medusa-watchdog.js` reads `control-state#status`; escalation recipients come from the assignment | an escalation about a held recipient says "held (generation N)"; the watchdog never writes `control_*` rows; priority never alters `control-gate` |
| C15 | **R19 / #1873:** `retracted` is a durable terminal state that is never escalated. It applies to ordinary correspondence only and can never erase HOLD/STOP/RELEASE control. B1 models the state; #1873 owns the API, UI, wake cancellation and retraction notice. | v49 columns and fact kind; `lib/medusa-exchanges.js#retract` (module function, no route); `lib/medusa-watchdog.js` terminal filter | retract from each pre-read state gives `retracted`; retract after `read`/`acknowledged`/`replied`/`closed` is `409 NOT_RETRACTABLE`; a simultaneous read and retract gives exactly one winner (a single guarded UPDATE); a duplicate retract is idempotent; a retracted exchange is never escalated across ticks or a restart; a late read or reply is appended as a fact but the state stays `retracted`; a control notice has no exchange row, so `retract` cannot reach it (`CONTROL_NOT_RETRACTABLE`) |
| C14 | Named acceptance cases: hour-scale stuck, blocking vs normal, validation, reserved critical, busy/draft/wrap, lost Enter, listener reconnect, session replacement, manual read, reply/closure, duplicate ticks, unavailable recipient; **every case ends acknowledged/replied or explicitly escalated** | all of the above | new `test/medusa-watchdog.test.js` has one case per item, each ending with the assertion `terminalOrEscalated(exchange)` |

---

## 3. Design summary (the recommended options from §4, assembled)

1. **A TangleClaw-side exchange record keyed by the Hub message id.** Every session on this host shares one TangleClaw database. So the *sender's* `/medusa/send` creates the row, holding priority, reply-required, deadline, sender and recipient, keyed by the Hub id the send returns. The *recipient's* listener, `/read` and wake then append facts to the same row. The Hub body stays the source of truth for content; TangleClaw owns delivery state. No body text is stored.
2. **A state machine** with an append-only facts table and a mutable cache table (the `control_receipts` pattern), written in one transaction.
3. **A watchdog timer** (`lib/medusa-watchdog.js`, 30 s tick) over *open* exchanges only. It never injects. It can (a) re-arm the wake monitor's edge for a message once, subject to backoff, and (b) emit escalations. All injection stays in `lib/medusa-wake.js` behind every existing gate.
4. **Escalations** go out as structured TangleClaw system notices over Medusa, the same shape as #1861's `control_changed` and built from ids, ages and reason codes only, never sender prose. They go to the sender, to the escalation principal named on the recipient's assignment, and to the operator (a dashboard banner plus `activity_log`).
5. **The wake transport** moves behind a small interface. Tmux (with the negative receipt reused from `wrap-delivery-receipt`) and master are the two adapters in this Car.

---

## 4. Choices requiring Architect rulings (A1–A5)

Each choice lists options with tradeoffs and ends with a **Recommendation**.

### A1 — State machine and storage

States live per exchange (one Hub message to one recipient). *Delivery* states run in order. *Escalation level* is a separate axis, so an escalation never rewrites a delivery fact.

```
stored ──► delivered_to_listener ──► wake_pending ──► wake_attempted ──► read ──► acknowledged ──► replied ──► closed
   │                │                     │  ▲             │   (tmux tops out here)                    ▲
   │                │                     ▼  │             ├──► wake_not_accepted (negative receipt) ──► re-arm (budgeted)
   │                │               wake_blocked(reason)   └──► wake_accepted (receipt-bearing adapters only)
   ▼                ▼
undeliverable   recipient_retired        terminal failure states, each reported to the initiator

 any state before `read` ──► retracted    terminal, never escalated (R19; the operation itself is #1873)
```

**`retracted` (Architect R19; implementation of the operation is #1873).**
- **Terminal and never escalated.** It is reachable only from `stored`, `delivered_to_listener`, `wake_pending`, `wake_blocked`, `wake_attempted` or `wake_not_accepted`, and only while no `read` or `acknowledged` fact exists.
- **Atomic.** The transition is one guarded `UPDATE … WHERE state IN (<pre-read states>)` inside the fact transaction, so a read and a retract that race resolve to exactly one winner. The loser records nothing, and the caller learns the winning state. A duplicate retract returns the original result (idempotent on `request_id`).
- **Auditable, never deleted.** A fact `retracted` carries the actor principal, a bounded reason code and an optional `replacement_hub_id`. It is a tombstone: the row and every earlier fact stay.
- **Late facts.** A read, ack or reply arriving after `retracted` is appended as an audit fact but does not change the state or reopen escalation.
- **Ordinary correspondence only.** Exchange rows are created for ordinary peer mail only. TangleClaw's control notices (`control_changed`) and B1's own escalation notices get no exchange row: they stay in `control_receipts` or as facts on the parent exchange. So `retract` has nothing to act on for control, and HOLD/STOP/RELEASE can be superseded only by a newer control generation (#1861). `retract` on a non-ordinary kind is refused with `CONTROL_NOT_RETRACTABLE`.
- **Split with #1873.** B1 ships the columns, fact kind, state transition, module function and watchdog behaviour, with unit tests, **so #1873 needs no migration**. #1873 ships the authenticated route, sender and recipient UI, cancellation of a pending wake, and the retraction notice for an already-injected wake. B1 adds no route and no UI for it.

- **`read`** means the recipient fetched the message through `GET /messages`. It is recorded only for ids actually returned, which is the observed fact.
- **`acknowledged`** means the message was named in `POST /read {ids}`. The actor is `recipient` (verified launch) or `operator-ui` (the panel auto-mark; see §8 P3).
- **`replied`** means a send by the recipient carried `inReplyTo: <hub id>` and that id is addressed to the replier.
- **`closed`** means the initiator closed it, or it auto-closed (see below).
- Escalation level is `none → sender_notified → escalation_notified → operator_alerted`. It is monotonic, with one fact per level.

| Option | Shape | For | Against |
|---|---|---|---|
| **A1-a** | New `medusa_exchanges` (mutable cache) plus `medusa_exchange_facts` (append-only, with triggers), v49. Mirrors `control_assignments`/`control_receipts`. | Per-message durable state; replay-verifiable; auditable; additive (rollback-safe); the proven #1861 pattern | Two new tables; the send path writes to SQLite |
| A1-b | Extend `medusa_deliveries` with new outcomes and columns | One table | The CHECK constraints force a table rebuild; the table is per-session, not per-message; it prunes to 100 rows per session, which loses hour-scale history; an older binary misreads the new outcomes |
| A1-c | In-memory state in the watchdog | No migration | Loses everything on restart, which fails "hour-scale" and "never silent" |

**Close rule sub-choice:**
1. Reply-required exchanges close on `replied` plus an initiator close, or on initiator close alone.
2. Non-reply exchanges auto-close on `acknowledged`.
3. Closure is always explicit.

Option (2) is fastest to "never silent" without adding operator work. Option (3) matches the "initiator closes" rule but leaves every normal message open forever unless agents learn a new verb.

**Recommendation: A1-a**, with auto-close on `acknowledged` for `replyRequired: false`. For `replyRequired: true`, `replied` counts as satisfied for the watchdog and closure stays with the initiator (`POST <base>/medusa/exchanges/:id/close`). Open-but-replied exchanges never escalate. ~~Retention: closed exchanges are pruned after 30 days.~~ **R20: no automatic pruning in this Car.**

### A2 — Priority validation and sender binding

The send route authenticates nobody today, so a claimed priority is worth only as much as the caller binding behind it.

| Option | Rule | For | Against |
|---|---|---|---|
| **A2-a** | `normal` needs no binding (unchanged). `blocking` requires the verified launch headers (`x-tangleclaw-project-id` plus `x-tangleclaw-launch-id`, via `control-auth#resolveControlCaller`) matching the URL project. `critical` requires operator proof (`verified-session`/`ambient-open`) or an internal system call. A violation is **rejected** (`403 PRIORITY_BINDING_REQUIRED` / `403 PRIORITY_RESERVED`), never silently downgraded. | Existing callers are unaffected; escalation noise can't be forged by an unbound process; reuses A1's caller resolver; the rejection is honest | `tc message send --priority blocking` must send the binding headers (it already has the launch env) |
| A2-b | Require binding on **every** send | Closes the #1861 §1 spoofing gap outright | A breaking change for every current caller (UI send, scripts, the Master); it widens the Car's scope into sender auth |
| A2-c | Accept any priority unbound, as advisory | Simplest | Any local process can page the PM or operator; contradicts the Train's "no authority from a nickname" stance |

Sub-points in all options:
- **Per-sender rate bound:** at most 5 open `blocking` exchanges per sender project; a 6th is `429 BLOCKING_LIMIT`.
- **`reason` is a bounded enum:** `awaiting-ruling`, `awaiting-review`, `awaiting-dispatch`, `incident`, `question`, `other`. It is not free text, because it is copied into escalation notices.
- **`replyRequired` defaults** to `true` for blocking and critical and `false` for normal.

**Recommendation: A2-a.** Filing the full sender-auth gap (A2-b) as its own issue is suggested in §8 P5.

### A3 — Timer and thresholds

| Option | Shape | For | Against |
|---|---|---|---|
| **A3-a** | A separate `lib/medusa-watchdog.js` on a **30 s** tick; thresholds in `DEFAULT_CONFIG.medusaWatchdog` with a range-checked resolver (the `resolveUnreadyWindow` precedent); a sender `deadline` may only *shorten* a threshold, within `[2 min, default]` | Independent of the 5 s wake tick; testable via `tick(now)`; operator-tunable with bounds | Adds a second timer |
| A3-b | Fold the watchdog into the wake monitor's 5 s tick | One loop | The wake tick is per-session, pane-driven and in-memory; mixing durable escalation into it couples two failure modes (a hung capture stalls escalation) |
| A3-c | Hard-coded constants | Least code | Can't be tuned without a release |

Proposed defaults (A3-a). Thresholds are measured from `stored`, except the reply threshold.

| Priority | Recipient/sender visibility ("aged") | Escalation principal notice | Operator alert | Reply threshold (after `acknowledged`, if reply required) |
|---|---|---|---|---|
| normal | 30 min | — | — | none |
| blocking | 5 min | 15 min | 60 min | 30 min → escalation principal |
| critical | immediate | immediate | 5 min | 15 min → operator |

- **Wake re-arm budget:** a message is re-armed only when (i) a negative receipt says the submit was not accepted, or (ii) the exchange sits at `wake_attempted` with no `read` for 3 min while the pane has since returned to an idle-at-prompt verdict (a state change, not a blind timer).
- **Backoff:** 2, then 4, then 8 min; **at most 3 re-arms per exchange**. Exhausting the budget escalates immediately with reason `wake-unconfirmed`.
- **An `engine-thread-unknown` or `pane-*` hold** past the visibility threshold makes the exact wake reason code the escalation's blocker (the #1628 criterion). It is never a force.

**Recommendation: A3-a with the defaults above.** The numbers are proposals and cheap to change. The ruling that matters is the structure (separate timer, sender may only shorten).

### A4 — Escalation routing: who "the PM" is

TangleClaw has no role record, so "notify the PM" needs a source that is not a nickname.

| Option | Source | For | Against |
|---|---|---|---|
| **A4-a** | A new optional key on the control assignment's operator-set `authority_json`: `escalation: { blocking: [principal…], critical: [principal…] }`, validated by `normalizeAuthority`. The recipient's open assignment gives the escalation targets. With no assignment, or no key, the escalation goes to the **operator only**. | Reuses A1's operator-only authority record; no new authorization system; no role guessing; per-assignment, so two Builders can have different PMs; `authority_json` is JSON, so no DDL change | The operator (or PM tooling) must set it at assignment creation; ungoverned projects get only operator escalation |
| A4-b | A global config key `medusaWatchdog.escalationPrincipal` naming one project | Trivial | One PM per install; not assignment-scoped; breaks the "dual Builders" target |
| A4-c | Infer from the assignment's `hold`/`stop` principals | No new field | Ambiguous (the Architect holds too) and implicit, which is exactly the nickname-style inference the Train rejects |

Delivery for every option:
- **Sender and escalation principal** get a Medusa system message, `{"event":"medusa_escalation","exchangeId","hubId","priority","level","ageSeconds","blocker":"<reason code>","recipient":"<project name>","controlState":"held|stopped|active|ungoverned"}`, and the send is itself recorded as a fact. Escalations are control-exempt only in the same sense as today's wake nudge: the notice is ordinary mail, and HOLD still gates every mutation.
- **Operator:** an `activity_log` row (`event_type: 'medusa-escalation'`) plus a new read-only `GET /api/medusa/escalations` (open, operator-level), rendered as a landing-page banner (`public/landing.js`, the behind-origin banner precedent).
- **External push** (ntfy, webhook or email) is out of scope. It is outward-facing config that deserves its own issue (§8 P4).

**Recommendation: A4-a**, falling back to the operator. The PM's assignment tooling setting `escalation` at dispatch is an operator workflow note, not code in this Car.

### A5 — Wake transport adapter

| Option | Scope | For | Against |
|---|---|---|---|
| A5-a | Interface plus the tmux, master **and** Codex-native (`turn/start` with `clientUserMessageId`, a positive receipt) adapters | Delivers the preferred receipt-bearing path now | Codex `fire` is startup-shaped (payload digest, reconcile); adapting it to mid-session wakes is a substantial engine change that doubles the Car; it risks colliding with #1628's still-open qualification work |
| **A5-b** | Interface (`lib/wake-transports.js`: `{id, receipts: 'positive'|'negative'|'none', deliver(ctx) → {outcome: 'accepted'|'attempted'|'not-accepted'|'refused', code}}`) plus **tmux** (with the reused negative receipt) and **master** adapters; the wake picks by profile capability instead of a ternary; a **fake positive-receipt adapter in tests** proves the `wake_accepted` path | Makes the transport replaceable, per the issue; bounded size; #1621 becomes *detected and escalated* instead of silent | The native path stays follow-up work, so tmux wakes top out at `wake_attempted` (honest, not proven) |
| A5-c | Keep the ternary; add receipts inline | Least code | Doesn't meet "keep the wake transport replaceable" |

A candidate for the follow-up issue is a **Claude Code `Stop`-hook adapter**. It runs at turn end, checks the durable exchange state for open blocking or critical mail, and returns `decision: block` with the notice. That gives Claude sessions a native, receipt-bearing wake with no tmux keystrokes. Codex native is the other candidate.

**Recommendation: A5-b**, with follow-up issues for the Codex-native and Claude `Stop`-hook adapters.

---

## 5. Branch, collision surface, migrations, copy, tests, rollback

**Branch:** `feat/1839-medusa-delivery-watchdog`, cut from `origin/main` at release time, in a linked worktree `.claude/worktrees/feat-1839`. The primary checkout is behind origin and is not used for work.

**Collision surface** (for the PM's matrix; Chunk B is sequential because of it):

| File | Change | Also touched by |
|---|---|---|
| `lib/store.js` | v49 migration, DDL helper, `medusaExchanges` accessors, `DEFAULT_CONFIG.medusaWatchdog`, `sessionsWithUndeliveredMail` derivation | every schema Car; **B2 (#1806)** likely |
| `server.js` | `/medusa/send` metadata and binding; `/read` and `/messages` facts; new `/medusa/exchanges*` and `/api/medusa/escalations`; `PATCH /api/config` whitelist; watchdog start/stop | B2, **B3 (#1717)** |
| `lib/medusa.js` | `sendMessage` returns the Hub id to the exchange writer (no Hub contract change); arrival hook | B2 |
| `lib/medusa-listener.js` | arrival callback (`delivered_to_listener`) | B2 |
| `lib/medusa-wake.js` | transport seam, wake facts, re-arm entry point | B2 |
| `lib/sessions.js#_teardownMedusa` | `recipient_retired` fact only | **B2 owns the carryover here: highest collision** |
| `lib/control-state.js#normalizeAuthority` | optional `escalation` key | B3 reads control state |
| `lib/tc-verbs.js` | `message send --priority/--reply-required/--in-reply-to`; `message status` shows exchange state | C1 (#1647) |
| `public/landing.js`, `public/api-helper.js` | escalation banner; panel ack actor | — |
| **new** `lib/medusa-exchanges.js`, `lib/medusa-watchdog.js`, `lib/wake-transports.js` | — | — |

**Migration:** v48 → v49 is additive only. It adds `medusa_exchanges` (cache) and `medusa_exchange_facts` (append-only, with UPDATE/DELETE-raising triggers) through a shared `_medusaExchangeTablesDdl()` used by both `_createTables` and the migration, with a `_verifyMedusaExchangeTablesV49()` postcondition. Indexes: `hub_id`, `(recipient_project_id, state)`, `(sender_project_id, state)`, and open exchanges by `stored_at`. **`medusa_deliveries` is not rebuilt.** #1435 is fixed by deriving "undelivered" from open exchanges (with a fallback to the ledger for pre-v49 rows), not by adding an outcome.

**Copy** (operator- and agent-facing; drafted here, final wording reviewed in chunk 05):

| Code / surface | Text |
|---|---|
| `400 PRIORITY_INVALID` | "priority must be normal, blocking or critical" |
| `403 PRIORITY_BINDING_REQUIRED` | "A blocking message must come from a verified session launch. Send it with your launch headers (`tc message send` does this)." |
| `403 PRIORITY_RESERVED` | "critical is reserved to the operator and TangleClaw. Use blocking if you cannot continue." |
| `400 DEADLINE_OUT_OF_RANGE` | "escalateAfter must be between 2 minutes and the priority's default (N minutes)" |
| `429 BLOCKING_LIMIT` | "You already have 5 open blocking messages. Close or wait on those first." |
| `404 REPLY_TARGET_UNKNOWN` | "inReplyTo does not name a message addressed to you" |
| Landing banner | "Medusa: 2 messages need attention. Oldest: blocking, 47 min, to TangleClaw-Builder1, blocked by pane-composer-has-input." |
| Sender notice | "Your blocking message to <recipient> has not been read after 15 min. Blocker: <meaning of reason code>. Escalated to <principal name>." |
| Undeliverable | "<recipient> is not reachable (workspace retired at <time>). Your message was not delivered. Resend to its current session." |

**Tests:** new `test/medusa-exchanges.test.js` (state machine, validation, replay, triggers); new `test/medusa-watchdog.test.js` (fake-clock thresholds, re-arm budget, idempotent escalation across ticks and restart, and every C14 case); new `test/wake-transports.test.js`; `test/store-medusa-exchange-migration.test.js` (v48→v49, fresh install parity, verify-refusal); additions to `test/api-medusa.test.js` (send metadata, binding, `/read` facts, #1435 regression) and `test/control-state.test.js` (the `escalation` key normalization). The existing `test/medusa-wake*.test.js` stay green **unmodified**, which is the C7 contract. The full suite runs on the worktree, never the main instance.

**Rollback:**
1. **Soft:** `medusaWatchdog.enabled: false` (config). The watchdog stops, metadata is still recorded, the wake behaves as before, and no escalation is sent.
2. **Code:** revert the merge. The v49 tables are additive, so a v48 binary ignores them. Open exchanges are **retained, not cleared**, and resume on re-upgrade. (This is the same caution #1867 documents for control state; chunk 05's docs will say so explicitly.)
3. **No Hub contract change**, so there is nothing to roll back outside TangleClaw.

---

## 6. Out of scope, and dispositions against neighbouring issues

The Train rule is to keep the issues separate unless a written disposition says otherwise.

- **#1806 (Car B2): carryover or transfer at wrap/replacement.** B1 records `recipient_retired` and **reports it to the initiator**. That satisfies #1839's "explicitly fail" and "report undeliverable" clauses. Delivering before teardown or transferring to a successor stays with B2, which will build on B1's exchange rows. #1806 stays open.
- **#1873: sender retraction.** B1 models the `retracted` terminal state, its v49 columns (`retracted_at`, `retracted_by`, `retract_reason`, `replacement_hub_id`) and its guarded transition, and the watchdog never escalates it (C15). The API, UI, wake cancellation and retraction notice stay with #1873. The PR says `Refs #1873`; #1873 stays open.
- **#1717 (Car B3): the merge-time inbox and control gate.** Not touched. B3 can read B1's open blocking exchanges.
- **#1435.** B1 fixes it (C8). The PR will say `Fixes #1435`, with this disposition quoted, **subject to the Architect's ruling (§8 P2)**.
- **#1621.** B1 *detects* a lost Enter (negative receipt) and escalates, re-arming within budget. It does not make the tmux submit reliable. #1621 stays open for a native adapter; the PR says `Refs #1621`.
- **#1628** is closed. B1 delivers its remaining "surface aged undelivered mail with the exact blocker" requirement through C10.
- **#801** stays open; B1 is one step toward the delivery guarantee it is gated on.
- **Not in B1:** native Codex or Claude adapters (§4 A5), external operator push (§4 A4), sender auth for `normal` sends (§4 A2), and cross-host exchange tracking (§8 P1).

---

## 7. Honest limits

- A tmux wake can never be proven accepted. The best B1 can say is `wake_attempted` or `wake_not_accepted`.
- **Priority can be claimed only by a bound caller.** The binding verifies the launch, not the intent: a bound Builder can still mark trivia as blocking. The rate bound and the audit trail are the mitigation.
- Cross-host peers (`local: false`) have no shared database. Normal mail to them is recorded as `untracked`, not escalated; blocking and critical are refused (R20 P1).

---

## 8. Smaller points needing a ruling

- **P1 — Cross-host recipients.** Record them as `untracked`, visible but never escalated (recommended), rather than smuggling metadata into the message body (forgeable, and it pollutes content).
- **P2 — Does #1435 close in this PR?** Recommended: yes. It is the same code path and the issue's own acceptance line ("close the stuck condition when mail is manually handled") requires it.
- **P3 — UI panel auto-ack.** Opening the inbox panel marks every displayed message handled. Recommended: keep the behavior, but record the actor as `operator-ui`, and have the sender notice say "acknowledged by the operator in the dashboard", so a silent close isn't mistaken for agent compliance. The alternative, "view ≠ ack" in the panel, is a UX change outside #1839.
- **P4 — External operator push.** File a separate issue (recommended); do not add outward-facing config here.
- **P5 — The `/medusa/send` caller-auth gap for normal sends.** File a separate issue (recommended); do not widen B1.

---

## 9. Build order (after release)

Commit per chunk, each with its own tests.

1. **Chunk 01: schema and state module.** v49 DDL, migration and verify; `lib/medusa-exchanges.js` (`create`, `appendFact`, `status`, `replay`, `listOpen`, and `retract` per R19, with no route); the retraction columns; triggers; replay parity; the read-versus-retract race test. *Thin slice:* one exchange goes from `stored` to `acknowledged` to `closed` in unit tests.
2. **Chunk 02: send and receive wiring.** `/medusa/send` metadata, binding and validation (A2); the send intent before the Hub, hub-id binding, and `send_unknown` (R20 A1); `WATCHDOG_UNAVAILABLE_REMOTE` (R20 P1); an invalid target or Hub refusal → `undeliverable` (R20 C11); listener arrival fact; `/messages` → `read`; `/read {ids}` → `acknowledged` (with actor); `inReplyTo` → `replied`; the `/exchanges/:id/close` route; the #1435 derivation; `tc message send` flags. **Governance checkpoint** (architecture validation): request a `final`-mode Critic here.
3. **Chunk 03: transport and watchdog.** `lib/wake-transports.js` (tmux with negative receipt, master); wake facts emitted from `_judgeSession`; `lib/medusa-watchdog.js` timer, thresholds resolver and config whitelist; the re-arm budget and backoff; fake-clock suite.
4. **Chunk 04: escalation and surfaces.** The `escalation` authority key; system notices to the sender and escalation principal; `activity_log` plus `GET /api/medusa/escalations`; landing banner; `tc message status`; `recipient_retired` at teardown and its initiator notice; control-state visibility in notices.
5. **Chunk 05: docs and exit.** New `docs/medusa-delivery.md` (states, thresholds, limits, rollback retention); FEATURES and README Switchboard line; CHANGELOG `### Added`; the operational-guide line; an E2E on an isolated instance (port leased via PortHub). The E2E sends a blocking message into a pane held at `pane-composer-has-input`, advances a fake clock, and proves the sender notice, the PM notice and the operator banner, then shows that a manual read closes it.

Then: the full suite on the worktree, the cumulative Critic, a draft PR, and a **STOP**. The PM owns readiness and merge.

---

## 10. Change ledger

- **Rev 1** (2026-09-25): written by the B2 Builder from the #1839 body, the Train Car B1 bullets, and two read-only scouts over `origin/main` @ `49a55381` (delivery/ledger path; wake/control integration). Every §1 fact was re-checked against the code anchors listed.
- **Rev 2** (2026-09-25): applies **Architect R19** (PM message `2d8502ad`), after #1873 was filed. It models `retracted` as a durable terminal watchdog state that is never escalated (§4 A1, C15, §6), limits exchange rows to ordinary correspondence so control can never be retracted, and leaves #1873's API and UI out of B1. Nothing else changed.
- **Rev 3** (2026-09-25): applies **Architect R20** (message `6f9218fb`) as the binding §0. It approves A1–A5 with amendments, rejects P1 as written, approves P2 and P3, files P4 as #1876 and P5 as #1875, and narrows C11. §2, §4, §7 and §9 are amended where they conflicted; §0 governs any remaining difference. R20 released implementation on this incorporation.
