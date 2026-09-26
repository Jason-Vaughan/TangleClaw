# Medusa delivery watchdog

Status: experimental (#1839). Schema v49.

A Medusa message used to be "sent" the moment the Hub stored it. Whether it
ever reached the agent it was for was nobody's job. A message could sit
unread for hours behind a busy pane, a half-typed draft, a lost Enter or a
wrap. The sender stayed blocked until the operator happened to notice a badge.

The watchdog makes delivery a record with an owner: every ordinary message is
tracked until it is answered, closed or explicitly failed, and one that is not
escalates instead of waiting silently.

## What it is, and is not

- **A server timer over durable state** (`lib/medusa-watchdog.js`, a
  30-second tick). It is not an agent: it spends no turns, has no inbox of its
  own, and survives a restart because everything it decides from is in
  SQLite.
- **It never types anything.** Waking a session stays the wake monitor's job
  (`lib/medusa-wake.js`). Every wake, including a re-armed one, passes every
  existing gate (busy turn, running subagents, a draft in the composer, a
  wrap in progress, identity, readiness) before a nudge is injected.
- **Priority grants nothing.** It changes timing and visibility only. It does
  not bypass a gate, a project rule or a HOLD/STOP, and it is not a control
  command.
- **The Hub keeps the message body; TangleClaw keeps its fate.** No message
  text is stored in these tables or copied into any notice.

## Exchanges

An exchange is one ordinary message to one recipient (`medusa_exchanges`),
keyed by the Hub's message id once the Hub has returned it.

- **Facts are the truth.** Each event is an append-only row in
  `medusa_exchange_facts`, and triggers refuse UPDATE and DELETE. The exchange
  row is a projection recomputed from its facts, and `replay` must reproduce
  it. Facts can race or land out of order (a read before the arrival record,
  a reply before the ack), so state is ranked by kind, not by sequence.
- **A send is recorded before the Hub is called**, then bound to the Hub's id.
  The two cannot commit together, so a send whose answer is lost is
  `send_unknown`, visible to the sender and never retried. A reused
  `requestId` is refused (`409 SEND_ALREADY_ATTEMPTED`) so a retry cannot put
  a second copy on the Hub.
- **Correlation is by Hub id only.** The Hub pushes a message to an online
  recipient before it answers the sender, so the recipient often records the
  arrival first. The send adopts that arrival when its answer comes back. An
  arrival no send on this host made is recorded as untracked, never guessed.
- **Control and escalation notices are not exchanges.** They come from
  `system`, so HOLD/STOP/RELEASE can never be closed or retracted through this
  record.

States: `send_pending`, `send_unknown`, `stored`, `delivered`, the wake states
(`wake_pending`, `wake_blocked`, `wake_attempted`, `wake_not_accepted`,
`wake_accepted`), `read`, `acknowledged`, `replied`, and the terminal
`closed`, `retracted`, `undeliverable`, `recipient_retired`. `untracked`
applies to mail this host cannot supervise. A reply-required exchange that
has been replied to reads "satisfied, awaiting initiator close".

## Sending

`POST <base>/medusa/send` takes, beside `to` and `message`:

| Field | Meaning |
|---|---|
| `priority` | `normal` (default), `blocking` (the sender cannot continue) or `critical` |
| `replyRequired` | Defaults to true for blocking and critical, false for normal |
| `escalateAfterMinutes` | Shortens the first escalation, down to 2 minutes. It can never lengthen it |
| `reason` | `awaiting-ruling`, `awaiting-review`, `awaiting-dispatch`, `incident`, `question` or `other` |
| `inReplyTo` | The Hub id of the message this answers |
| `requestId` | An idempotency key; see above |

Who may claim what:

- **Plain normal sends** still work without a launch binding, and are
  recorded as unverified.
- **`blocking` needs a verified launch** of the sending project (the
  `x-tangleclaw-project-id` and `x-tangleclaw-launch-id` headers;
  `tc message send` sends them).
- **`critical` is the operator's and TangleClaw's alone.** The operator's
  proof tier is recorded (`verified-session`, or `ambient-open` on a
  deliberately open gate).
- **Anything that changes an existing exchange** (`inReplyTo`, closing,
  retracting) needs a verified launch of the right project, or the operator.
- **A claim that cannot be proven is refused, never downgraded.** The codes
  are `PRIORITY_BINDING_REQUIRED`, `PRIORITY_RESERVED` and
  `EXCHANGE_BINDING_REQUIRED`.
- **At most 5 open blocking messages per sender** (`429 BLOCKING_LIMIT`).
- **Protected priorities are refused off-host.** A blocking or critical
  message to a workspace no live session on this host holds is refused
  (`422 WATCHDOG_UNAVAILABLE_REMOTE`), because nothing here could supervise
  it. Normal mail to it is recorded as untracked.

From a pane: `tc message send --priority blocking --reason awaiting-ruling <workspace-id> <text…>`.

## Reading, acknowledging, replying, closing

- `GET <base>/medusa/messages` records `read` for the messages it returns.
  `POST <base>/medusa/read {"ids": [...]}` records `acknowledged`. Both apply
  only to mail addressed to the reading session, and record who did it:
  - `recipient`: a verified launch;
  - `operator-ui`: the dashboard, whose inbox panel marks everything it shows
    as handled;
  - `unverified-reader`: an unproven caller.
- **A message that needs no reply closes on acknowledgement**, whoever
  acknowledged it; the record names who.
- **A reply-required message stays open until a reply arrives.** An
  acknowledgement from the dashboard or an unverified caller never satisfies
  it, so a sender is never told the agent answered when it did not.
- **Replying:** send with `inReplyTo`.
- **Closing:** the original sender closes an exchange with
  `POST <base>/medusa/exchanges/<exchange-id>/close` (`tc message close`).
- **Listing:** `GET <base>/medusa/exchanges?direction=sent|received&open=1`
  lists them without bodies, and `tc message sent` shows the sender's open ones.

## Wakes and re-arms

The wake monitor still nudges once per fresh-mail edge, and now:

- **Each nudge carries its own nonce**, `(wake ref <hex>)`, and its verdicts
  are recorded on the exchanges it concerned: blocked with the gate's reason,
  pending, or attempted.
- **The delivery transport is chosen per session**
  (`lib/wake-transports.js`). Guarded tmux injection can prove only that a
  nudge was *not* accepted (its nonce still in the composer, #1621's lost
  Enter), never that it was. A tmux wake tops out at "attempted". A transport
  with an engine-native receipt records `wake_accepted`; the Codex-native and
  Claude Stop-hook adapters are follow-up work.
- **After a nudge, the monitor keeps judging the pane without typing**, so a
  later change in readiness is recorded.
- **After a restart**, the monitor consults the recorded attempts before
  treating mail as un-nudged, so a restart never sends an extra wake.

The watchdog re-arms a wake only on a durable trigger newer than the attempt:

- **a negative receipt**, eligible at once; or
- **a recorded readiness change** (`readiness_changed`): the session was found
  ineligible after the nudge (busy, blocked, engine not idle, listener
  reconnecting) and eligible again since. Both halves are durable. It is
  eligible no sooner than `rearmAfterMs` after the attempt.

A re-arm passes the draft gate like any wake, and that gate makes one exception:
a composer holding **only** a switchboard nudge and its wake ref, seen down to the
composer's lower border, is the switchboard's own stranded text rather than the
operator's (#1621). The pane counts as at the prompt, the injector's prompt clear
removes the stale nudge without filing it in the draft store, and a fresh nudge
with a new nonce replaces it. The composer is read again after the clear: if any of the
stale nudge is left, because an engine's line-kill cleared only one wrapped row, the
injection is refused rather than pasted after the leftover. Operator text before or after the nudge, or a
composer whose end was not captured, is refused as before. Without the exception
the stranded nudge refused the re-arm it had earned, and every later wake, until
the exchange escalated. An engine whose composer draws no lower border gets no
exception, so its stranded nudges still wait for the re-arm budget to run out and
the escalation that follows.

The exception recovers from a lost Enter. It does not prevent one: why the Enter
after the paste is sometimes lost has not been established.

**Elapsed time alone never re-arms and never spends the budget.** A nudge
with no trigger stays unconfirmed and escalates by age instead. Re-arms back
off (2, 4, then 8 minutes) up to 3 times. The count and the next eligible time
are stored, so duplicate ticks and restarts re-arm nothing twice.

## Escalation

An open exchange climbs a one-way ladder. Each step is recorded once, from
server time, before its notices go out:

| Step | Normal | Blocking | Critical |
|---|---|---|---|
| **Aged**: the sender is told | 30 min | 5 min | at once |
| **Escalated**: the route is told | — | 15 min | at once |
| **Operator**: dashboard and activity log | — | 60 min | 5 min |

- **Timing.** Unread is measured from the send. Acknowledged but unanswered
  (reply required) is measured from the ack. For blocking mail nothing
  happens for 30 minutes after the ack; then the sender and the route are
  told together, and the operator is alerted 60 minutes after that. For
  critical mail, already escalated when sent, the operator is alerted 15
  minutes after the ack. The ladder runs once per exchange: steps reached
  while it was unread are not repeated once it is acknowledged. A spent
  re-arm budget escalates at once.
- **Retirement leaves answered mail alone.** An exchange that has been
  replied to is waiting on its sender, so its recipient's session ending does
  not end it.
- **The route** is an optional list on the recipient's control assignment,
  `authority.escalation: {blocking: [...], critical: [...]}` (see
  `docs/control-state.md`). It is set by the operator when the assignment is
  created, never inferred from a role or a workspace name, and it grants no
  authority. With no route, or for an ungoverned project, the operator is
  alerted at the escalation step.
- **Notices** are Medusa system messages, `{"event": "medusa_escalation", …}`,
  carrying the exchange and Hub ids, priority, age, the blocker's code and
  meaning, names, and the recipient's control state and generation (so a
  notice about a held Builder says it is held, and which hold). Each is recorded as
  `escalation_queued`, then `escalation_accepted` (the Hub stored it, which
  is not "delivered") or `escalation_failed`. A target with no live session
  is `escalation_undeliverable`, and the operator alert still stands.
  Notices never become exchanges themselves.
- **The operator** sees a dashboard banner for any exchange at the operator
  step and any critical one. It rides the existing `/api/server-info` poll
  as `medusaEscalations`. `GET /api/medusa/escalations` lists every escalated
  exchange with names, age and blocker. Each operator alert also writes an
  activity row, `medusa-escalation`.
- **Retracted and closed exchanges never escalate.**

## Undeliverable and retired recipients

- **Not failures:** a listener disconnect, or a workspace missing from the
  roster, is queued or blocked. The Hub redelivers.
- **Terminal:** only three things end an exchange as undeliverable: an
  explicit Hub refusal (`undeliverable`), an invalid target, or durable
  retirement.
- **Retirement:** when a session ends, its workspace id is forgotten for good.
  Every open exchange addressed to it ends as `recipient_retired`, and each
  initiator is told. Carrying the mail to a successor session is #1806.

## Settings

Under `medusaWatchdog` in `PATCH /api/config`. Values are bounded, and a patch
merges over what is stored. A bad stored value is ignored with a warning,
never used.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` stops re-arms and escalation; recording continues |
| `tickMs` | 30 000 | Pass interval (applies at the next server start) |
| `rearmAfterMs` | 180 000 | Minimum gap between an attempt and a readiness-change re-arm |
| `backoffMs` | `[120000, 240000, 480000]` | Minimum gap between successive re-arms |
| `maxRearms` | 3 | Re-arm budget per exchange |
| `agedNormalMs`, `agedBlockingMs` | 30 min, 5 min | The aged step |
| `escalateBlockingMs` | 15 min | The escalated step for blocking |
| `operatorBlockingMs`, `operatorCriticalMs` | 60 min, 5 min | The operator step |
| `replyBlockingMs`, `replyCriticalMs` | 30 min, 15 min | Acknowledged-but-unanswered thresholds |

## Limits

- **Tmux wakes are unconfirmed at best.** A pane can prove a nudge was not
  accepted, never that it was.
- **A priority claim is only as good as its binding.** A bound Builder can
  still mark trivia as blocking. The per-sender limit and the audit trail are
  the mitigation.
- **Cross-host exchanges are not supervised.** Normal mail to them is
  untracked, and protected priorities are refused.
- **Nothing prunes these tables yet.** Retention is #1879.
- **Retraction** is modelled (the `retracted` state and its guarded
  transition) but has no route yet; that is #1873.

## Rolling back

v49 only adds tables. A v48 server ignores them and the rows survive: a
rollback does not clear open exchanges, and a re-upgrade resumes supervising
them. Setting `medusaWatchdog.enabled: false` stops re-arms and escalation
without a rollback.

## Code

`lib/medusa-exchanges.js` (rules and projection), `lib/medusa-watchdog.js`
(timer, re-arms, escalation), `lib/wake-transports.js`, `lib/medusa-wake.js`
(wake facts, observe-only watching, the restart check), `lib/store.js`
(`medusaExchanges`, v49), `server.js` (the `/medusa/*` routes,
`/api/medusa/escalations`), `lib/control-state.js#escalationRouteFor`,
`public/landing.js#renderMedusaEscalationBanner`. Tests:
`test/medusa-exchanges.test.js`, `test/api-medusa-exchanges.test.js`,
`test/medusa-watchdog.test.js`, `test/medusa-escalation.test.js`,
`test/medusa-watchdog-e2e.test.js`, `test/store-medusa-exchange-migration.test.js`.
