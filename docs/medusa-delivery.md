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
| `requestId` | An idempotency key; see above. An id beginning with a prefix a TangleClaw component keeps for its own sends (the operator bridge's is `bridge:`) is refused, `400 REQUEST_ID_RESERVED`, with nothing sent |

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

- `GET <base>/medusa/messages` records `read` for the messages it returns,
  except when the dashboard fetches them. `POST <base>/medusa/read {"ids": [...]}`
  records `acknowledged`. Both apply only to mail addressed to the reading
  session, and record who did it:
  - `recipient`: a verified launch;
  - `operator-ui`: the dashboard. Its inbox panel is a pure observation (#1987):
    opening it records nothing, never acknowledges and never clears the unread
    count. A `read` fact would take the message out of awaiting-read, end its
    wake re-arms and make it unretractable, and a cleared count would cancel
    the agent's wake nudge, all for mail the agent has not seen. Only an
    explicit handled-mark from the dashboard is recorded, as `acknowledged`.
    A browser-shaped request that is not the agent's verified launch counts
    as the dashboard for reads, so an auth gate in fallback (operator
    unproven) does not turn viewing into an unverified read;
  - `operator`: the operator outside the dashboard (an authenticated API call);
  - `unverified-reader`: an unproven caller that is not browser-shaped.
- **A message that needs no reply closes on acknowledgement**, whoever
  acknowledged it; the record names who.
- **A reply-required message stays open until a reply arrives.** An
  acknowledgement from the dashboard or an unverified caller never satisfies
  it, so a sender is never told the agent answered when it did not.
- **Replying:** send with `inReplyTo`. A reply must carry the sender's
  launch headers, or it is refused with `EXCHANGE_BINDING_REQUIRED`;
  `tc message send --in-reply-to <message-id> <workspace-id> "<reply>"` sends
  them. **Reply before acknowledging** (#1976). For a message that needs no
  reply, the acknowledgement closes the exchange. For one that does, an
  acknowledgement with no reply leaves the sender waiting. The wake nudge, the
  prime and the engine config all state this order. The nudge and the
  engine config also say never to use `/clear` as an acknowledgement.
  The Project Master's nudge states the same order with its raw routes only
  (`POST <base>/send`, then `POST <base>/read`): `tc message` needs a project
  identity, which the Master does not have. Every nudge is built to stay
  under 800 characters, wake reference included: Claude Code shows a longer
  paste as `[Pasted text #N]`, and a nudge that collapses that way cannot be
  recognised if its Enter is lost. The project nudge therefore names its API
  base once, with `GET /messages`, `POST /send` and `POST /read` relative to
  it, and is held to 750 characters for the longest name `validateName`
  accepts. A name registered without that check (#2180) is not covered.
- **Every write needs the caller's identity (#2233).** `POST <base>/send`,
  `POST <base>/read`, the exchange close and the loop routes are refused with
  `403 LAUNCH_BINDING_REQUIRED` unless the request carries the session's
  launch headers (`x-tangleclaw-launch-id` and `x-tangleclaw-project-id`), or
  for the Project Master `x-tangleclaw-role: master` with its launch id.
  `tc message` sends a session's headers; both nudges name what a raw call
  needs. The inbox and roster reads need neither.
- **Closing:** the original sender closes an exchange with
  `POST <base>/medusa/exchanges/<exchange-id>/close` (`tc message close`).
- **Listing:** `GET <base>/medusa/exchanges?direction=sent|received&open=1`
  lists them without bodies. `tc message sent` shows the sender's open ones, and
  `tc message owed` shows the recipient what it still owes: replies first, then
  messages not yet handled. An `untracked` exchange (one this host cannot
  supervise) is counted aloud but never listed as owed, because its state
  cannot show whether it was handled. A send still in flight is not listed,
  and a full 200-row page is reported as possibly incomplete.

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
  treating mail as un-nudged, so a restart never sends an extra wake. It asks
  about each message in the inbox by its own Hub id (#2086). The Hub
  redelivers mail that was never marked handled, so a message the recipient
  already fetched comes back as unread. A message is the recipient's already
  when its exchange shows the recipient read or acknowledged it, whether or
  not it was ever nudged, or shows a nudge with no re-arm pending; a restart
  is not a reason for another. A message the record cannot vouch for (no id,
  no exchange, neither read nor nudged, or re-armed) makes the answer no, so
  new mail is not hidden behind old. Mail with no exchange record, and
  untracked mail the recipient has not fetched, are therefore nudged once per
  server lifetime. The record is asked by the message body's `id`, which is
  what arrivals and reads are recorded under.

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

**Panes are read without blocking the server (#2086).** The monitor's tick
runs its gates, asks tmux for the pane of every session holding mail at the
same time, and returns. Each answer is judged when it arrives:

- **Every gate runs again on the answer**, on the session as it is then. A
  wrap or rotation that began, mail already read, a listener that dropped or
  a wake recorded meanwhile refuses the nudge. A read for a session that has
  ended, whose id names another pane, or whose workspace changed
  (`pane-read-stale`) is discarded.
- **A read is given 4 seconds.** A pane that does not answer is left alone for
  10 seconds, then 30, then 60 (`pane-read-backoff`). One ordinary read ends
  that. A hung pane delays no other session.
- **One read per session at a time**, and none is acted on after the monitor
  stops.
- **A tick that got no look at a pane is not an observation of it.** A
  timeout, a failed read, a backoff and an answer that took 3 seconds or more
  each end the idle streak, and a nudge needs two fresh at-rest observations
  at least 4 seconds apart.
- **Judging an answer asks tmux nothing**, so a wedged tmux server cannot hold
  the server through it.

**Something happening asks for a look (#2086).** The monitor does not wait
for its timer when one of these is recorded for a session: mail arrives, its
listener returns to `listening`, its project's wrap finishes, or its
coordinator rotation closes.

- **A request is not a command.** It runs the same scan, through every gate,
  and one look never nudges. A look that was asked for and finds the pane at
  rest books a single follow-up 4 seconds later, and the timer leaves the
  session alone until then. Mail for a pane at rest is nudged about 4.4
  seconds after it arrives, where the timer alone took 5 to 10.
- **Requests are bounded.** They are coalesced per session, and dropped when
  the monitor is stopped, when the pane is being read, has a follow-up booked,
  is backed off, or was observed less than 4 seconds ago.
- **A busy pane coming to rest is still found by the timer.** No engine pushes
  a "turn finished" event the monitor could use.
- **Requests are in memory.** A restart loses them and the timer covers.

None of this types anything a tick would not have typed. The measurements are
in [medusa-wake-measurements.md](medusa-wake-measurements.md).

**Elapsed time alone never re-arms and never spends the budget.** A nudge
with no trigger stays unconfirmed and escalates by age instead. Re-arms back
off (2, 4, then 8 minutes) up to 3 times. The count and the next eligible time
are stored, so duplicate ticks and restarts re-arm nothing twice.

## What a held wake means

Every wake the monitor withholds has a reason code. A code says what was
observed, not whether waiting will fix it. One classifier
(`lib/medusa-delivery-disposition.js`) answers that, and both readers below
use it (#2086):

| Class | What it means | Examples |
|---|---|---|
| `actionable` | The recipient is live and the monitor retries by itself. Waiting fixes it. | A busy pane, a wrap in progress, a listener reconnecting |
| `configuration` | The recipient is live and nothing changes until someone acts. | Wake not opted in, an engine with no wake profile, a listener that is off |
| `historical` | The recipient session is not live. | A session that ended with mail deferred |

- **`tc message status <workspace-id>`** prints the class and what to do
  beside the reason. The peers route returns them as `class`, `nextAction` and
  `nextActionMeaning`. A reason that is not a held wake (`nudged`, `no-mail`)
  has the class `none`. When the wake monitor is not running, nothing is
  retrying anything and the verdict is stale, so the answer is `configuration`,
  to be investigated, whatever the last reason was. It never tells a sender to
  wait for a monitor that is stopped.
- **`GET /api/medusa/deliveries`** returns every session whose newest mail was
  not nudged. `undelivered` is the whole list, as before. Each item now also
  carries `class`, `live`, `reason`, `since`, `lastAssessedAt`, `ageMs`,
  `nextAction` and `nextActionMeaning`, and the response adds `actionable`,
  `configuration` and `historical` (the same items, partitioned) and
  `summary` (counts, the oldest actionable age, and any reason code no class
  is declared for).

Two rules decide the doubtful cases. A reason code the classifier does not
know is `configuration`, to be investigated, and is logged once. A row is
`historical` only when something positively says its session is not live: the
store holds no active session under that id. Where that cannot be established
the row is `configuration`, never `historical`.

`actionable` is a promise that the monitor retries by itself, so no row is
`actionable` unless the monitor is positively running. With it stopped, a row
that would have been is `configuration`, to be investigated, in the words the
sender-facing answer uses. Rows that were already `configuration` or
`historical` are classed as they were.

The Project Master is the one exception to "not live means historical". It is
a single identity that stops and starts, so a stopped Master holding mail is
`configuration`, to be started, and its mail waits for it. A project session
that ended is replaced by a different session, and stays `historical`.

`since` is when the ledger recorded the current verdict. `lastAssessedAt` is
when the monitor last looked at a live session, and is null until it has. The
read writes nothing: old rows are classified, not removed.

## Escalation

An open exchange climbs a one-way ladder. Each step is recorded once, from
server time, before its notices go out:

| Step | Normal | Blocking | Critical |
|---|---|---|---|
| **Aged**: the sender is told | 30 min | 5 min | at once |
| **Escalated**: the route is told | — | 15 min | at once |
| **Operator**: dashboard and activity log | 60 min, or at 30 min for a reason below | 60 min | 5 min |

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
- **A notice says whether waiting will fix it (#2086).** Every notice carries
  `class`, `nextAction` and `nextActionMeaning` from the classifier under
  "What a held wake means": a busy recipient is `actionable`, one that never
  opted in is `configuration`, and a message that was nudged and not yet read
  is `none`. With the wake monitor stopped, no notice promises a retry: a hold
  that would otherwise be `actionable` reads as `configuration` with
  `investigate`. That applies to held wakes only. A message that was nudged,
  read or acknowledged holds no wake and stays `none` whatever the monitor is
  doing, and a `configuration` hold keeps its own next action.
- **The exchange record's own codes are translated first.** A blocked or
  pending exchange usually carries the monitor's reason, but the record
  writes two codes itself: `rearmed` (the monitor will look again, read as
  `not-observed`) and `awaiting-read` (the newest mail was already nudged,
  read as `nudged`). One mapping in `lib/medusa-exchanges.js` owns them, and
  the notice classifies what the code stands for, never the code itself.
- **A nudge that was not accepted is not a nudge.** It waits on a re-arm, so
  it reads as `actionable` while the watchdog can still re-arm it. Once the
  re-arm budget (`maxRearms`) is spent nothing retries, and it reads as
  `configuration` with `investigate`. A wake the monitor is still holding is
  retried by the monitor and is not affected by that budget.
- **A notice says what the message is waiting for.** `condition` is `unread`,
  or `unanswered` for a message that was acknowledged and still owes a reply.
  It is separate from `class`: an acknowledged message holds no wake, so its
  class is `none`, and it is still plainly unanswered.
- **Normal mail reaches the operator once.** It never reaches the escalation
  route, and the sender is told once, at the aged step. It used to stop
  there, which left the cases only an operator can resolve silent for ever.
  After the aged step, each pass asks why the operator should be told, until
  it has been:
  - `configuration-hold`: nothing changes until someone acts. Told at the
    aged step.
  - `engine-thread-unknown-stalled`: the engine's own channel has not said
    the session is idle for 10 minutes without a break, the same interval the
    wake monitor's own stall alert uses, and the message has aged. A recipient
    whose state only just became this is not stalled: the count starts when
    the state does, and starts again if it ends and returns. The monitor still
    retries, and the class stays `actionable`.
  - `prolonged-actionable`, `prolonged-unread`: the recipient is merely busy,
    or was nudged and has not read. Told at `operatorNormalMs`, and never
    sooner than the aged step.
  - `prolonged-unanswered`: the recipient acknowledged the message, a reply
    is owed, and none has come for `operatorNormalMs` since the
    acknowledgement.
- **The operator alert is one fact and one activity row.** The
  `operator_alerted` fact is recorded once, and the activity row is written in
  the same transaction, only by the pass that recorded it. Repeated passes, a
  restart and competing passes add neither. A row that cannot be written
  leaves no fact, and the next pass records both: the row is written with a
  store write that throws on a failed insert or trim, where the ordinary
  activity write swallows its failures. The row is filed under the recipient
  project when that project still exists, and without one otherwise, so a
  deleted project cannot refuse it for ever. The row and the dashboard's
  escalation list both carry `condition`. The fact keeps the blocker,
  the condition, its class and next action, and why the operator was told, as
  they were then. A later change of class neither repeats the alert nor rewrites it.
- **An operator alert is not a message.** It wakes nobody and costs no turn.
- **Untracked mail is not on the ladder.** A message to a workspace no live
  session on this host holds cannot be supervised from here. Its own host
  owns that.
- **Retracted and closed exchanges never escalate.**

### A send a TangleClaw component owns

Most system messages are notices and make no exchange. One kind does: a message a TangleClaw
component sends to a session on someone else's behalf and tracks, as the operator bridge's
gateway does when it carries an operator's message to a project.

Such a component can declare that it owns what it sends
(`lib/medusa-exchanges.js#declareSystemOwner`). A send is then that component's when three things
hold together: it has verified system provenance and no sending project, its sender is the
component's listener, and its request id begins with the prefix the component declared.

- **The watchdog does not raise it, at normal priority.** No aged notice, no escalation, no
  operator alert. A blocking or critical send is escalated like anyone's. The
  component decides what happens when it goes unread or unanswered. It is still re-armed, still
  woken for, and still ended when its recipient retires.
- **The component closes it,** in-process, and only its own
  (`closeAsSystemOwner`). No route reaches that close. `POST .../exchanges/<id>/close` admits
  the operator and the sending project's verified launch, as before, and nobody else.
- **Nothing else is exempt.** A system send from a component that has declared nothing, or one
  missing any of the three proofs, is an ordinary exchange.

The operator bridge's gateway is the only declared owner. See
[operator-bridge.md](operator-bridge.md), "The one status notice".

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
| `operatorNormalMs` | 60 min | When normal mail that is merely waiting reaches the operator. From 5 minutes to 48 hours. Never sooner than `agedNormalMs` |
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

## What is proven, and what is not

`test/medusa-wake-exchange-proof.test.js` runs the real wake monitor, the real
exchange record and the real watchdog against a store on disk (#2086). Each
server lifetime is a separate process on the same database, so nothing in
memory crosses a restart. Only the tmux pane, the listener and Hub, and time
are stand-ins. It holds that:

- an eligible recipient gets one nudge, one recorded attempt and one nonce,
  across any number of ticks and restarts;
- a miss buys one re-arm, the backoff and the re-arm budget survive restarts,
  and time alone re-arms nothing;
- a receipt marks only the messages whose newest nudge it names;
- a held wake is recorded once, survives a restart and is still delivered;
- the aged notice and the operator alert are each sent once across restarts;
- mail that was fetched but not marked handled is not nudged by a restart,
  whether it was fetched after a nudge or before one was ever recorded, and
  never hides new mail.

Limits of that proof, which are not defects:

- **No positive receipt.** The tmux transport can prove a miss only, so there
  is no `wake_accepted` case for a project session.
- **The delivery ledger is not exactly-once.** A held wake writes one more
  `skipped` ledger row per restart. The exchange fact is not repeated.
- **The operator alert is a snapshot.** A nudge that keeps missing alerts once
  at the hour as `prolonged-actionable` while a re-arm is still pending, and a
  budget that runs out later does not alert again.
- **Real tmux, a real Hub and a real server restart are not exercised.**

`test/medusa-wake-codex-fixtures.test.js` runs every Codex pane fixture
against every answer the engine's channel can give. The fixtures carry the
codex-cli version they were captured from. **The only version proven is
0.155.1.** No other version is, and nothing infers that another behaves the
same. Two further limits: the `thinking` pane was derived from Codex's help
text and never captured, so what the gate does with it when the channel says
idle is not asserted; and the channel's answers are TangleClaw's own
normalized shape, so the Codex app-server protocol is not proven by these
fixtures.

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

What each wake tick and watchdog pass cost is recorded in memory by `lib/tick-meter.js`
(`medusaWake.tickMetrics()`, `medusaWatchdog.tickMetrics()`); it observes and decides nothing.
[medusa-wake-measurements.md](medusa-wake-measurements.md) holds the scale and lifecycle
measurements taken with it (#2086).
