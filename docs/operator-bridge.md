# The operator bridge

The operator bridge lets the operator reach the fleet from a chat application and get answers
back in the same conversation. [ADR 0023](adr/0023-master-mediated-operator-bridge.md) records
the design: a durable gateway on the server carries each message, the Project Master session
decides where it goes and what the operator reads, and neither is authority.

This page describes what is built. The interim Discord procedure that is in force until cutover
is in [discord-operator-notifications.md](discord-operator-notifications.md).

## Status

| Part | State |
|---|---|
| Storage (schema v52, reshaped by v53, extended by v54) | Built |
| The Project Master's bridge credential | Built |
| Gateway: accept, resolve, dispatch, hold the reply, release | Built |
| `tc bridge` for the Project Master, routing and answering included | Built |
| The helper's six routes and its scoped token | Built |
| The operator's policy routes: enable, allowlist, token, aliases, pins | Built |
| The candidate lane: a session offers, the Master decides | Built |
| The three typed server notifications | Built |
| Discord helper (`bin/tc-bridge-helper`) | Built; not yet run against Discord. See [operator-bridge-helper.md](operator-bridge-helper.md) |
| The operator's dashboard panel (global settings, Operator bridge) | Built; not yet used by a person on a live install |
| Cutover | Not started; Rule #145 is unchanged and in force |

The bridge is **disabled by default**. Only the operator can enable it, signed in with an
account session, and only after setting the allowlist and creating the helper token. The
helper is not installed by anything here: until the operator sets it up, enabling the bridge
connects to nothing, no chat message can arrive and nothing posts to a chat application.

### What ADR 0023 still requires

ADR 0023 is accepted for architecture only. Its acceptance does not authorise merging an
implementation, assigns no schema number and does not activate cutover.

- **Schema numbers.** 52, 53 and 54 were each the next free number on `main` when taken, under
  the Architect's rulings of 2026-10-04.
- **Merge.** Each change merges only after an exact-head independent security review, and is
  never set to merge automatically.
- **Cutover.** Not part of any change so far. It needs the security review, a live round trip
  and the operator's approval to replace Rule #145. Enabling the bridge on a live install is
  part of cutover, not something to do because the switch exists.

## How a message travels

```
inbound    helper ──▶ gateway (held, with a suggestion) ──▶ Master routes ──▶ destination session   (or the Master itself)
outbound   destination session ──▶ gateway (held) ──▶ Master releases ──▶ gateway ──▶ helper
```

1. **The helper hands over a message.** The gateway refuses it unless the bridge is enabled and
   the message is from the one allowlisted author, space and channel. A refused message is
   counted and none of it is kept.
2. **The gateway stores it as a route**, keyed on the chat's own message id. A replay of the
   same message returns the same route. The same id with different text, or from a different
   place, is refused.
3. **The gateway works out where the message looks to be going, and sends it nowhere.** It
   looks, in this order, at:
   1. a leading `@name`;
   2. the route of the message this one replies to, or the Project Master when it replies to a
      posted message that has no route (see "What a reply answers");
   3. a pin on the conversation: the operator's for that conversation, then the operator's for
      every conversation, then the Master's;
   4. the default, which is the Project Master itself.

   What it finds is recorded beside the route as a **suggestion**, and the route waits
   (`awaiting-master`). An address, a reply, a pin and the default never send a message
   anywhere.
3a. **The Master routes it.** `tc bridge routes` shows each waiting route with its suggestion.
   `tc bridge route <route-id> --version <n> --to <master|project>` is the decision, and the
   Master may decide otherwise than the suggestion. Nothing applies a suggestion later: not a
   pass, not time, not a restart, not a pin made afterwards. This is the operator's ruling of
   2026-10-05: the Project Master is the router in both directions.
4. **A project destination gets a tracked Medusa message** from the gateway, reply required,
   normal priority. Its first line says it is operator conversation and approves nothing. The
   gateway records exactly who it was sent to: the project, workspace, session and launch.
5. **The reply is held.** The gateway accepts a reply only when the sender's own exchange record
   shows a verified launch answering exactly that message from exactly that project, workspace,
   session and launch. Anything else is dropped and counted. A held reply is posted nowhere.
6. **The Master releases an answer**: the held reply unchanged, or its own words. Only then
   does an item exist for the helper.
7. **The helper posts it and acknowledges** with the chat's id for the post. The text is then
   dropped, the route is closed and every body held for it is cleared.

When the Master is the destination there is no Medusa round trip. It still routes the message
to itself first, with `--to master`, and then answers with `tc bridge answer`: one rule, with no
exception for the commonest case.

### Telling the Master

The gateway tells the Master through its Medusa listener, with a system notice the existing wake
monitor turns into a nudge. It tells it once for each state a route reaches that needs it: a
route to decide, a route that is the Master's to answer, a reply held for release, and again if
a route is handed back after a failure. A notice that could not be sent is not recorded as
given, so the next pass sends it.

**The Master is told through its Medusa listener, so the bridge is not enabled without one.**
Enabling is refused `409 MASTER_LISTENER_OFF` while the Master is not a switchboard participant.
If the listener goes away afterwards, a route still waits and its status notice still fires;
the operator's status shows whether the Master can be told (`masterListener`) and how many
routes are waiting on it untold (`routesMasterNotTold`). A route is told again for each state
it reaches, so the count includes one told of an earlier state and not of the one it is in.
The guard reads the Master's setting, not whether a Master is running at that moment.

### Sending exactly once

A message is sent to its destination once. One route is advanced by one caller at a time, and
before a message is sent the gateway looks for an exchange already made for that attempt. What
it finds decides what happens:

| What is found | What happens |
|---|---|
| No exchange, and the send is refused before the Hub is called | Nothing was sent. The route goes back to the Master to route again. |
| An exchange with the Hub's message id | The message is on the Hub. It is recorded and the route is `routed`. |
| The Hub answered with a message id, but the exchange row could not take it | The id is kept in the audit and the gateway binds the row itself, on this pass and every later one. Until it binds, the route waits as unconfirmed; once it does, the route is `routed`. A route is never `routed` on an exchange without its Hub id, because the target's reply is found through that id. |
| The Hub refused the message (`undeliverable`) | Proven undelivered. The route goes back to the Master. |
| On the Hub, but for a session that can no longer be named | The route is marked `send-unconfirmed` and is not sent again. The operator's one notice says the message was handed over and that its reply could not be accepted, not that nothing is known. |
| An exchange under the attempt's request id that the gateway did not send | It is not the gateway's, so it is not adopted: nothing is taken from it, no proof is recorded, and the route goes back to the Master with `request-id-collision`. The next attempt has a new request id. |
| Anything else: still pending, or the outcome unknown | The route stays where it is. After two minutes it is marked `send-unconfirmed`, the operator gets one notice saying so, and the Master is told. |

**An unconfirmed send is never sent again**, by a later pass, after a restart, or by the Master
routing it: the request id of an attempt changes only when the attempt is recorded as sent or
proven undelivered, so the existing exchange is always found first. A recipient session that
ends does not prove an unconfirmed send was undelivered, and does not reopen it. The Master can answer an
unconfirmed route in its own words or close it. Only a proven failure reopens routing.

The gateway finds its own sends by request id, so the ids it makes, which begin `bridge:`, are
kept for it. A Medusa send from anything else under such an id is refused before it is recorded
(`400 REQUEST_ID_RESERVED`).

### Addresses

An address is a leading `@name` that names **exactly one** destination the bridge may reach:

- `@master`, which always means the Project Master and cannot be an alias;
- a nickname, which the operator asks the Master for in the chat (see "Nicknames");
- a project's exact name, without regard to case;
- a project's slug: its name in lower case, with each run of anything but a letter or a digit
  made one dash. It counts only while exactly one reachable project has it;
- a project's id.

### Nicknames

A nickname is a second name for a project, or for the Master: `@tc-arc` for TangleClaw
Architect. It is an overlay on a project id and nothing more. It is only ever a suggestion to
the Master, so a message addressed by one still waits to be routed; it changes no rule,
credential or permission; and it grants nothing.

**They are managed by asking the Master in the chat.** The operator writes to `@master`:
"remember @TC-ARC means TangleClaw Architect", "list nicknames", "what is @tc-arc?", "rename
@tc-arc to @arch", "forget @tc-arc". When the message says exactly one thing, the Master routes
it to itself, makes the change with `tc bridge nickname`, and answers in the same conversation
with `tc bridge answer`. When it does not, the Master asks first, as set out below.

**Every change rests on one operator message,** named by `--answered-by`, and the check is
mechanical:

- **The instruction itself:** an inbound the operator wrote to `@master`, by that name, which
  the Master has routed to itself, still open, and which has authorised no nickname change
  before. This is enough when the message says exactly one
  thing: the target is one reachable project and the name is free.
- **A reply to a clarifying question:** when such a message does not say exactly one thing,
  the Master asks with `tc bridge ask` and names the operator's reply. The question must be
  about a message the operator wrote to `@master`. Adopting it is one
  write, all of it or none (Architect ruling, 2026-10-05): the change is made, the message the
  question was about is routed to the Master as the Master's own decision about it, the
  question is settled and the reply's route is closed. There is no later route step and nothing
  in between for a failure to leave half done. If that message cannot be routed to the Master
  as it stands, the write is refused `409 NOT_AWAITING_MASTER` and nothing is used.

The order matters, because a question can only be asked about a message that still waits for
the Master. A message that says one thing is routed to the Master and then acted on. A message
that does not is asked about first; the change is made on the reply, and that same write
routes the first message to the Master, which then answers it. The answer to the write
carries `instruction`, the first message's route with its new state and version.

**Only a message written to `@master` carries this authority** (Architect ruling, 2026-10-05).
What the operator addressed is recorded when the message arrives and is never rewritten. A
message written to a project, to a nickname (one that means the Master included) or to nobody
authorises no nickname change, and none through a reply to a question asked about it, even
when the Master routes it to itself. The reply to such a question still does everything else a
reply may do. The Master tells the operator to ask `@master`. It is the message asked about
that is read, so a reply that itself opens with `@master` changes nothing; and a message with
no such record, as one accepted by an earlier build would be, authorises nothing: send it again.

One message authorises one change, whichever way it was used: an instruction whose clarifying
reply authorised a change authorises no second one of its own. Whether its words ask for that change is the Master's
reading; the audit records the nickname, the target and the message's route id, and none of
its text.

| Refused | Answer |
|---|---|
| The message was not written to `@master`, or is a reply to a question about one that was not; or it is not one the Master has routed to itself, is closed, or does not exist | `409 NOT_AN_INSTRUCTION` |
| The message has already authorised a nickname change | `409 INSTRUCTION_USED` |
| On a reply: the message its question was about cannot be routed to the Master as it stands | `409 NOT_AWAITING_MASTER` |
| A reply that is not the answer to an open clarifying question | `409 NOT_AN_ANSWER`, `QUESTION_SETTLED`, `QUESTION_EXPIRED`, `QUESTION_PURPOSE` |
| The name is `master`, or `set`, `rename` or `forget`, which `tc bridge nickname` reads as what to do | `409 NICKNAME_RESERVED` |
| The name is already a nickname | `409 NICKNAME_EXISTS` |
| The name is a reachable project's name or slug, or is all digits. A number is a project's id, whether or not a project has that id yet | `409 NICKNAME_COLLIDES` |
| The name is not 1 to 64 letters, digits, dots, dashes or underscores | `400 BAD_NICKNAME` |
| No such nickname, on a rename or a forget | `404 NICKNAME_NOT_FOUND` |
| The target is not something the bridge may reach | As for any destination, below |

Every refusal is on the audit, against the operator's message, with the nickname it was about.
A refused change uses nothing up: the same message can still authorise the corrected one. A
name is never allowed to mean two things when it is written; if a project is later created or
renamed onto an existing nickname, the name is ambiguous and is never guessed at.

A nickname whose project goes out of reach stays on record and names nothing until that
changes; `tc bridge nickname <name>` says why. Each nickname records who last set it (the
operator, or the Master), when, the operator message behind a Master's change, and the name as
it was typed. The operator's panel lists them with that record and can remove one; the
operator's alias routes remain for putting things right, and are held to the same rules.

### What the bridge may reach

No project is connected to the bridge by hand. A project is reachable when it is in the
registry, is not archived, is inside the Project Master's scope, and has not been opted out by
the operator. That is worked out from the registry each time it is asked, and remembered
nowhere: a project created a moment ago is reachable now, and one archived, deleted, opted out
or moved out of the scope a moment ago is not. One resolver (`lib/bridge-reach.js`) answers for
what the gateway suggests, what the Master may route to, pin to or ask to have launched, and
what a launch re-checks. A nickname is an overlay on a project id: one whose project is out of
reach names nothing.

- **The Master's scope bounds it, and fails closed.** A scope that names a project group which
  no longer exists, that is not a scope the bridge understands, or that cannot be read, reaches
  no project at all. The Master's own identity text falls back to every project in that case;
  the bridge does not. It is said, with which of the three it is, not left as an empty list:
  `tc bridge status` and `tc bridge destinations` say `SCOPE UNRESOLVED`, the operator's panel
  says so, a refused write says so, and the gateway audits the change with its cause once when
  it happens (`scope-unresolved`) and once when it is put right (`scope-resolved`).
- **A suggestion is always something that can be routed to.** A reply to a message that went to
  a project since taken out of reach, and a pin that points at one, suggest nothing
  (`destination-out-of-reach`). The operator's own aliases and pins are refused for a
  destination out of reach, by the same codes as the Master's writes.
- **Asked again at the send.** A message the Master routed while its project was reachable,
  and not yet sent when the project went out of reach, goes back to the Master as
  `destination-out-of-reach` and is sent nowhere.
- **Opting a project out is the operator's alone,** from the signed-in panel
  (`POST /api/bridge/operator/optouts` and `DELETE /api/bridge/operator/optouts/:projectId`). The Master has no way to do it, and
  nothing said in the chat does it. It takes effect at once and is audited.
- **`tc bridge destinations`** lists each reachable project with every name it answers to and
  how it stands: running; not running; running but unreachable over Medusa; or with more than
  one live session. A session a message can be sent to is one the server holds a Medusa
  listener for and a launch record for, since a reply is proven against that record. That one
  definition answers both "may this be routed to" and "may this be launched", so a refusal
  from one never points at the other in a circle.
- **More than one live session of a project is an anomaly, and is never guessed at.** Launch
  policy allows one. Nothing is sent to either: a route write is refused
  `409 TARGET_AMBIGUOUS`, and a message whose project gains a second session before it is sent
  goes back to the Master as `target-ambiguous`. The Master asks the operator.

A destination the Master names that the bridge may not reach is refused, with the message left
held as it was and the refusal on the audit by its code:

| What was named | Answer |
|---|---|
| Nothing known, or an archived project | `400 UNKNOWN_DESTINATION` |
| More than one thing | `409 DESTINATION_AMBIGUOUS` |
| A project outside the Master's scope | `409 DESTINATION_OUT_OF_SCOPE` |
| A project the operator opted out | `409 DESTINATION_OPTED_OUT` |
| Any project, while the scope is unresolved | `409 SCOPE_UNRESOLVED` |

An address is a suggestion to the Master, like every other way a destination is found: it
names where the operator meant the message to go, and the Master's route write is what sends
it. An `@name` that matches nothing, or more than one destination, is never guessed at: the
route waits with no suggestion and the reason: `address-unresolved` for a name that is
nobody's, `address-ambiguous` for one that is two things', and `address-out-of-reach` for a
nickname or a project's name whose project the bridge may not reach. A
chat application's own mention syntax, such as `<@123>`, is not an address, and neither is an
`@name` in the middle of a sentence.

A suggestion is made once, when the route arrives. A later change to pins, aliases or the
default does not rewrite it, and a destination the Master has fixed on a route does not move.

### When something does not arrive

- **The target has no live session, or the send is refused before it leaves:** the route goes
  back to the Master to route again, and the operator gets one failure notice.
- **The exchange later fails** (undeliverable, recipient retired): the same.
- **Nobody knows whether it arrived:** see "Sending exactly once". It is not sent again.

**The notice is part of the write it reports.** Each of these is one store transaction: the
route is handed back (or marked unconfirmed) and the operator's notice is queued together, or
neither happens and the next pass finds the failure again from the records. So an accepted
message that then fails is reported exactly once: a stop at any moment cannot leave the route
changed with the operator untold, and no pass, retry or restart makes a second notice. The
notice is a reply to the operator's own message, a fixed sentence the server wrote, and carries
nothing of the message, the session or any credential. A send that has not ended reports
nothing.

**A consented launch that fails is reported the same way.** Ending the launch, putting its
closed failure code on the held message, and queuing the operator's notice are one transaction:
all three or none. If it does not land, the launch is still unsettled, and the next pass comes
back to it and does all three. So the operator who agreed to a launch is always told when it
did not end in their message being sent on, once, in a fixed sentence that names a closed code
and nothing else. The message stays held for the Master; nothing is decided by the notice.
- **The Master is not running:** the gateway starts it, at most once per backoff window (15
  seconds, doubling to 10 minutes). If it cannot, the route is queued. Nothing falls back to
  the Architect.
- **A different session of the target project answers,** or the target was relaunched: that is
  not a reply. Reaching another session takes the Master routing the message again.

### The one status notice

A route gets at most one `status` item in its life: that the Master is unavailable, or, after
five minutes without a final answer, that the message is still waiting. Whichever comes first
is the only one. Its text is one of two fixed sentences the server wrote; a status item cannot
carry anything anybody typed. A message gets no "still waiting" notice while a question about
it is open, since the wait is then the operator's, nor after one has run out and the operator
was told so, since that notice already says the message is still held. A question that was
answered, withdrawn or never posted stands in for nothing, and the ordinary notice still goes.

The Medusa message the gateway sends to the project gets no notice of its own. The gateway
declares the exchanges it sends as its own (`lib/medusa-exchanges.js#declareSystemOwner`), and
the delivery watchdog does not raise a declared owner's normal-priority send to any rung: no aged notice, no
escalation, no operator alert, no dashboard entry, however long it waits. It is still an
ordinary open message in every other way, which is what delivers it: the wake monitor nudges the
target session for it, and a target whose session ends is recorded on it, which is how the
route gets back to the Master.

The gateway ends that exchange itself, since no session can. It stays open exactly while the
route is waiting on that send: the route is `routed` on that message, or is still `accepted`
and that send is the attempt being resolved, whose Hub id may yet bind. It is closed the moment
the route moves on (its reply is held, the Master answers, reroutes or closes it), and on every
pass for any that a crash left open. That pass runs while the bridge is disabled too, so a route
closed or let go while it is off does not leave its exchange open. A route that is still
`routed` when the bridge is disabled keeps its exchange until the Master closes the route, which
the rollback runbook has it do. Closing changes nothing about what it was: a later reply
that names the message still finds it, and is then refused for where the route is, by name.

### Asking the operator about a held message

When the Master cannot tell where a message should go, it asks, with
`tc bridge ask <route-id> --version <n> --text "<question>"`.

- **The message stays held.** Its route stays `awaiting-master`, its text stays stored, and
  nothing is sent to any session. The question is posted to the operator as a reply to their
  own message.
- **One question at a time.** A second `ask` on the same message is refused
  `409 QUESTION_OPEN`. A message that is no longer waiting for the Master cannot be asked about
  (`409 NOT_AWAITING_MASTER`).
- **The operator answers by replying to the question in the chat.** That reply is an inbound
  like any other: it gets its own route, waits for the Master, and routes nothing by arriving.
  The bridge records, when it arrives, which posted message it replies to.
- **The Master adopts the answer when it routes the original:**
  `tc bridge route <route-id> --version <n> --to <dest> --answered-by <the reply's route-id>`.
  In one transaction the question is settled, the reply's route is closed and its text cleared,
  and the original is routed. What is sent on is the original message, as the operator wrote it.

Only a recorded reply to that very question can be adopted. The check is mechanical and looks at
nothing the reply says:

| The route named by `--answered-by` is | Answer |
|---|---|
| Not a reply to anything, a reply to something else, a reply to another message's question, or no route at all | `409 NOT_AN_ANSWER` |
| A reply to this question, which has already been answered, cancelled or has run out | `409 QUESTION_SETTLED` |
| A reply to this question, past its time, before the gateway's pass has marked it | `409 QUESTION_EXPIRED` |
| A reply whose own route is no longer waiting | `409 REPLY_NOT_HELD` |
| A reply with an item of its own in the helper's hands | `409 OUTBOUND_IN_FLIGHT`; ask again once the lease has settled |
| Not shaped like a route id | `400 BAD_ANSWERED_BY` |

A refusal changes nothing. Whether the reply's words mean what the Master takes them to mean is
the Master's judgement, and the audit records both route ids and none of the text.

A question can be answered for 24 hours. After that the gateway marks it expired and sends the
operator one fixed sentence saying the message is still held and nothing was sent on. A
question that was never posted is withdrawn instead, and the operator, who never saw it, is
told nothing. Either way the message itself is not closed and not routed: the Master is told,
and may ask again, route it on its own reading, or close it.

What ends an open question without an answer:

- **Routing or closing the message without `--answered-by`.** An answer that arrives afterwards
  answers nothing. If the question has not been posted yet it is withdrawn and never posted.
  While the helper holds it and may be posting it, the write is refused
  `409 OUTBOUND_IN_FLIGHT`, to be made again once the lease has settled.
- **Withdrawing the question's item** (`tc bridge withdraw`, or a circuit reset that withdraws).
  The message can then be asked about again.
- **Adopting a reply closes that reply's route,** and with it any question the Master had asked
  about the reply itself.

The Master being away does not end one. A message queued because the Master is unavailable is
still held, and what was asked about it stands when the Master is back.

### Launching a project that is not running

A message for a project with no live session is never sent anywhere by routing it, and a
session is never started without the operator saying so.

1. `tc bridge route` to such a project is refused `409 TARGET_OFFLINE`. The message stays held.
2. The Master asks: `tc bridge ask-launch <route-id> --version <n> --project <project>`. The
   server writes the question, in fixed words: "<project> is not running. Would you like me to
   launch it?" Nothing is launched by asking. Refused for a project that is running
   (`409 TARGET_LIVE`), one with a session running that cannot be reached over Medusa
   (`409 TARGET_UNREACHABLE`: there is nothing to launch, and it is the operator's to look
   at), one the operator has opted out (`409 DESTINATION_OPTED_OUT`), and a message that
   already has a launch under way (`409 LAUNCH_IN_PROGRESS`).
3. The operator replies to that question in the chat.
4. On a yes, `tc bridge launch <route-id> --version <n> --answered-by <the reply's route-id>`
   records the consent. The same correlation rules apply as for any question, and only a reply
   to a launch question is consent to launch (`409 QUESTION_PURPOSE` otherwise). The write
   launches nothing: the message stays held, with a launch `queued` for it.
   On a no or a cancel, `tc bridge decline <route-id> --version <n> --answered-by <the reply's
   route-id>` closes the message and clears its text. Nothing is launched and nothing is sent.
5. **The server launches.** On its next pass the gateway takes the oldest queued launch, if
   none is in flight. It first does the launch route's own warm-up, which reads the network
   and can take many seconds. Then, with nothing awaited in between, it asks again whether
   anything stands in the way, whether a session is already live, and calls the function the
   launch route calls, with the project's saved settings and no override of engine, mode,
   prompt or permission. (The route also resolves the operator's host and checks for stranded
   wraps afterwards; the bridge has no request to read a host from, and does neither.) One
   launch is in flight on the install at a time; the rest wait in the order consent was
   adopted. If a session for the project is already live, because someone started it by hand
   in the meantime, nothing is launched and that session is the one waited for.
6. **The message is sent on only when all of this holds at once:** the session the launch
   named is still the project's active one; its launch sequence carries the launch id recorded
   and has attested READY; its recovery gate is not withheld; the server itself holds a Medusa
   listener for it; and the project's control lane is neither held nor stopped. READY is an
   unauthenticated attestation, so it is one condition and never the proof alone. Then the
   original message goes to that session, as the operator wrote it.

A launch question can be answered for an hour. No answer, an answer after the hour, a second
answer, and anything that is not a reply to that question launch nothing.

Before launching, and on every pass while waiting, the gateway asks again whether anything
stands in the way. Each of these ends the launch with a closed code and launches or sends
nothing more:

| Code | Why |
|---|---|
| `project-gone`, `project-archived`, `project-opted-out`, `project-out-of-scope`, `scope-unresolved` | The project is no longer one the bridge may reach. |
| `held`, `stopped`, `control-unavailable` | The project's control lane is held or stopped, or could not be read. The launch route itself refuses only a stopped lane; the bridge refuses both. |
| `wrap-running` | A wrap is running for the project. |
| `launch-refused:<CODE>` | The launch function refused. Only its own closed code is passed on, never its prose. |
| `launch-error` | The warm-up or the launch threw, the launch could not be recorded, or it could not be judged for the whole of its wait. A session that had started is left running, and the server log names it. |
| `identity-unknown`, `identity-changed` | The session has no launch record, or is no longer the session the launch named. |
| `ready-not-applicable` | The session's launch has nothing to attest, so it can never say it is READY. Said at once. |
| `ready-timeout` | Ten minutes passed without every condition of step 6 holding. |

On any of them the operator is sent one fixed sentence carrying the code, the message goes back
to waiting for the Master with the code on it, and the Master is told. No other target is
tried and nothing is retried: another launch needs another consent. A session that did start
is left running; the bridge never ends one. `tc bridge read` shows where a launch stands.

The session the message is sent to is held to the launch at the moment of sending as well: if
another session has taken its place in that instant, the message goes back to the Master as
`identity-changed`. That binds the one send the launch made. A later decision by the Master to
route the same message is its own, and goes to whichever session is live then.

**A limitation, accepted for v5.31.** Whether a project's session will have a Medusa listener
cannot be known before the session runs, so a project whose Medusa is switched off is launched
like any other on the operator's consent. Its session can attest READY and still cannot be
sent to. The launch holds the one launch slot for the ten minutes of its wait and no longer,
then ends as `ready-timeout`: the operator and the Master are told, the message stays held,
the session is left running, and nothing is sent or launched again without a new decision.
The bridge does not try to predict a listener.

Closing the message abandons its launch. Disabling the bridge abandons every launch not yet
settled, and enabling it again revives none. Nothing about a launch is kept in memory: after a
restart the gateway reads the same rows and carries on, and a launch is never made twice.

## The Project Master's credential

The Project Master has no project and no session row, so nothing TangleClaw records at a
project launch can prove a request is the Master's. The bridge gives it a credential of its own.

- **Minted at launch.** Creating the Master session mints a credential and records it as the
  next *generation*. Every earlier generation is revoked in the same step.
- **Hash only.** The server keeps the SHA-256 of the credential and never the value.
- **One purpose.** It authorises the `/api/bridge/master/*` routes and nothing else. The Master's
  role header and launch id do not stand in for it, and it grants no other access.
- **Revoked when the Master ends.** Killing the Master revokes it. After a server restart, a
  handoff the restart interrupted is revoked, and an active credential is revoked when tmux
  reports no Master. If tmux does not answer, a running Master keeps its credential.
- **A Master that was already running has none.** It must be relaunched to hold one.

### How it reaches the pane

The credential must reach the Master's environment without being an argument to any command.
`tmux new-session -e` and `tmux set-environment` both fail that: the first puts the value in
argv, and both leave it in the tmux session environment, where `tmux show-environment` returns
it. So:

1. The server makes a FIFO with mode 0600 in `bridge-handoff/` under TangleClaw's state
   directory (mode 0700). That directory is beside the Master's home, not inside it.
2. The pane's launch command names the FIFO's path. It runs `bin/tc-bridge-receive`, which reads
   one line into `TANGLECLAW_BRIDGE_CREDENTIAL` and removes the FIFO.
3. The server writes the credential once the pane has the FIFO open, then removes the FIFO too.

Both ends are bounded. If the pane never opens the FIFO, the server gives up, revokes that
generation and removes the FIFO. If the server never writes, the pane stops waiting and launches
without the credential. The Master still runs; it lacks the bridge capability until relaunched.

### What the credential does not protect against

These are the host's current trust boundary. The credential does not defeat them, and no
isolation between sessions running as the same user is claimed.

- **Another process running as the same user** can read a process's environment, and so can
  read the credential.
- **The Master's own shell** can print the variable. The Master's generated identity tells it
  not to; nothing structural prevents it.

Whether this boundary is acceptable for cutover is decided by the security review that precedes
cutover. If it is not, the bridge stays disabled and the interim procedure stays in force.

## `tc bridge`

For the Project Master only. `bin/tc` forwards the credential from the pane's environment to
the bridge's own routes and nowhere else, so it is never typed.

| Command | Does |
|---|---|
| `tc bridge status` | Says whether the bridge is enabled and which generation is asking. Answers while disabled. |
| `tc bridge destinations` | Lists every project the bridge may reach, with each name it answers to and whether it is running. Worked out as it is asked (`GET /api/bridge/master/destinations`). Answers while disabled. |
| `tc bridge nicknames`, `tc bridge nickname <name>` | Lists every nickname, or explains one: what it means, whether that is reachable and running, who set it and on which message. Answer while disabled. |
| `tc bridge nickname set <name> --to <dest> --answered-by <route-id>` | Stores a nickname the operator asked for. |
| `tc bridge nickname rename <name> <new-name> --answered-by <route-id>` | Gives a nickname a new name. What it points at does not change. |
| `tc bridge nickname forget <name> --answered-by <route-id>` | Removes a nickname. |
| `tc bridge routes [--state <state>]...` | Lists routes, oldest first, without bodies. Open states by default. |
| `tc bridge read <route-id>` | Shows one route with the text still held for it. |
| `tc bridge route <route-id> --version <n> --to <dest>` | Names the destination of a route that is waiting for the Master. The gateway then sends it. With `--answered-by <route-id>`, also adopts that operator reply as the answer to the question asked about it. |
| `tc bridge ask <route-id> --version <n> --text "<question>"` | Asks the operator one question about a message that is waiting for the Master. The message stays held. `--text-file <file>` reads the question from a file. |
| `tc bridge ask-launch <route-id> --version <n> --project <project>` | Asks the operator, in the server's fixed words, whether to launch a session for a project that is not running. Launches nothing. |
| `tc bridge launch <route-id> --version <n> --answered-by <route-id>` | Records the operator's reply as consent to that launch. The server then launches, waits for the session to be ready, and sends the message on. |
| `tc bridge decline <route-id> --version <n> --answered-by <route-id>` | Closes the message on the operator's no or cancel. Nothing is launched or sent. |
| `tc bridge answer <route-id> --version <n> --text "<text>"` | Answers the operator in the Master's own words. `--text-file <file>` reads the answer from a file. |
| `tc bridge release <route-id> --version <n>` | Sends on, unchanged, the reply the gateway is holding. |
| `tc bridge pin <route-id> --version <n> --to <dest>` | Pins the route's conversation to a destination. Conversation-scoped only. |
| `tc bridge close <route-id> --version <n>` | Closes a route, clears its text and withdraws anything released for it and not yet posted. |
| `tc bridge blocked` | Lists the items the helper could not post and the bridge set aside, without their text. |
| `tc bridge requeue <item-id>` | Puts a set-aside item back for the helper. |
| `tc bridge withdraw <item-id>` | Withdraws an item that has not been posted. Final. When the item is a route's answer, the route is closed and its text cleared with it: nothing more is coming for that route. |
| `tc bridge circuit ack <episode>` | Says the Master has taken up the open configuration episode. The gateway then stops telling it. The episode stays open. |
| `tc bridge reset (--requeue \| --withdraw)` | Closes the open configuration episode and puts back, or withdraws, the items it set aside. Withdrawing a route's answer this way closes that route and clears its text, as `withdraw` does. |

`<dest>` is `master`, or a reachable project's id, exact name, slug or nickname.

The Master is read-only everywhere else. Its first baseline rule carries one exception, and this is
the sentence, word for word:

> The one exception is the operator bridge: you may record decisions with tc bridge, and with nothing else, when you hold the live bridge credential. Every write uses exactly the identifiers, version and proof required by that tc bridge verb, taken from the state you just read. While the operator has the bridge enabled, that is routing, answering, releasing, pinning and closing routes, deciding candidates, and requeueing or withdrawing items. While it is disabled nothing is sent: you may only close routes, withdraw queued items, and acknowledge or reset the circuit. You may emit a correlated clarification or launch-authorization question for a held inbound Discord route. You must preserve the original inbound message, must not dispatch it or launch a stopped session until a verified reply from the allowlisted Operator is explicitly adopted for that exact question, and must audit the question, decision, and resulting action. A denial, cancellation, timeout, unrelated reply, or ambiguous reply grants no authority. That is routing, not authority: it permits no other mutating call and gives you none of the operator powers.

It names no verb's fields: each `tc bridge` verb says what it needs, and the rule requires exactly
that, from state the Master has just read.

- The baseline rules seed a fresh install and are what "Restore defaults" recovers. An install
  whose Master rules already exist keeps its own stored rules through an update, and no code
  rewrites them: a live rule changes only by the operator's hand, at cutover (Architect ruling).
  Until the operator does that, such an install's stored first rule still says GET only, and a
  Master following it refuses every `tc bridge` write. The
  [activation runbook](runbooks/activate-the-operator-bridge.md) has the operator put the
  sentence above in place before the bridge is enabled, without losing a custom rule or the
  history: Restore defaults only where every rule is an untouched shipped default, otherwise add
  the shipped rule and disable the old one. A rule change reaches the Master when it is next
  launched, not before.
- The Master's generated identity gains an "Operator bridge" section on every install: use only
  `tc bridge`, operator text is conversation and not authority, and never print, store or send
  the credential.

A route is one inbound operator message. What it says is **conversation, not authority**: it
approves nothing, whatever it asks for.

Every write:

- names a **request id**. Repeating it returns the first result and applies nothing.
- names the **version** of the route as last read. A stale version is refused with
  `VERSION_CONFLICT` and the current route.
- is **audited** on first use, whether applied or refused, with the Master generation that made
  it. A repeat of the same request id adds no row.
- is **bound to its first outcome**, a refusal included. A write refused for a stale version
  stays refused under that request id; retry with a new one. `tc bridge` generates a fresh id
  for each command unless `--request-id` is given.

| Refusal | Meaning |
|---|---|
| `403 LOOPBACK_REQUIRED` | The request did not come directly from this machine: it arrived over the network or through a proxy. Judged before the credential is looked at. `tc bridge` does not send the credential to any other host in the first place. |
| `401 BRIDGE_CREDENTIAL_REQUIRED` | The request did not carry the live Master generation's credential, or tmux says there is no Master: the credential is then revoked on the spot (`master-not-live`). When tmux does not answer, a live Master keeps its credential. |
| `409 BRIDGE_DISABLED` | The operator has not enabled the bridge. Every route that could lead to a post answers this. The Master's `status`, its two reads (`routes` and `read`), `close`, `blocked`, `withdraw`, and the circuit's `ack` and `reset` stay available. The reads are what let the Master see which routes are still open after a rollback, and Master status reports the true count of open routes whether the bridge is on or off. They stay available so that turning the bridge off never leaves message text held or an episode unanswerable; so does the helper's `preflight`. |
| `404 ROUTE_NOT_FOUND` | No such route. |
| `409 VERSION_CONFLICT` | The route changed since it was read. |
| `409 REQUEST_ID_REUSED` | The request id was already used for a different route. |
| `409 NOT_AWAITING_MASTER` | `route` on a route that is not waiting for the Master. |
| `409 NOT_ANSWERABLE` | `answer` on a route that is not waiting for one: it has not been routed yet (`awaiting-master`: route it first, `--to master` if it is for the Master), is still being sent, already has an answer, or is closed. A route marked `send-unconfirmed` can be answered. |
| `409 NO_REPLY_HELD` | `release` on a route with no held reply. |
| `409 REPLY_NOT_DISPLAY_SAFE` | The held reply contains control or text-direction characters. Answer in your own words instead. |
| `400 UNKNOWN_DESTINATION` | The destination is not `master`, a project id or an exact project name. |
| `400 ANSWER_REQUIRED`, `413 ANSWER_TOO_LONG`, `400 ANSWER_NOT_DISPLAY_SAFE` | The answer is empty, over 8000 characters, or contains control or text-direction characters. |
| `409 ALREADY_CLOSED` | The route is already closed. |
| `409 OUTBOUND_IN_FLIGHT` | `close`, `withdraw` or `reset --withdraw` while the helper holds, under a live lease, any item the write would withdraw: the item itself, or another item of a route the write would close. The helper may be posting it at this moment, so a write that succeeded could be followed by the post it was meant to prevent. Nothing is changed. Ask again once the lease has settled: at most two minutes, or at once after the helper token is revoked. |
| `refused`, with "Nothing was sent" | `circuit ack`, `requeue` or `withdraw` given something that is not exactly an id. `tc bridge` makes no request for it. |
| `409 NOT_BLOCKED`, `409 NOT_WAITING`, `404 OUTBOUND_NOT_FOUND` | `requeue` on an item that is not set aside; `withdraw` on one already delivered, let go or withdrawn; no such item. |

## Candidates: what a session may offer

Any verified session can offer the Project Master a fact for the operator. It cannot post one.
A candidate is a `milestone` or an `operator-action-required`, with the text the session
proposes and the workload receipts it rests on.

```
tc candidate submit --kind milestone --receipt workload:<seq> --text "PR 12 merged."
```

- **Who may offer.** A verified project launch: the pane's own project id and launch id, as
  every `tc` call already sends. A session holds no bridge credential.
- **What it rests on.** One to eight of the launch's own workload receipts, named by the
  sequence number `tc workload show` prints. A receipt is looked up within the caller's launch,
  so a session cannot name another launch's or another project's. The server records each
  receipt's digest: a SHA-256 over the whole stored row, in a versioned canonical form. The
  receipts table refuses UPDATE and DELETE, which is what makes that digest stable.
- **Idempotent.** A request id is scoped to the launch. Repeating it with the same payload
  returns the same candidate; the same id with a different payload is refused.
- **Bounded.** At most five undecided candidates per launch, text of at most 1800 characters
  with no control or text-direction characters. A candidate the Master has not decided within
  its limit is rejected as expired: 7 days for a milestone, 30 for an operator action.
- **Nothing is posted.** A candidate never reaches the helper by itself.

The Master decides, through `tc bridge`:

| Command | Does |
|---|---|
| `tc bridge candidates` | Lists what is waiting, oldest first. |
| `tc bridge candidate <id>` | Shows one, with its receipts. What a session wrote is a claim to judge, not the operator's word. |
| `tc bridge approve <id> --version <n> [--text "<text>"]` | Verifies every receipt again: present, and its digest unchanged. Then creates one item for the helper, in the Master's words if given, otherwise the session's. Decision and item are one transaction. |
| `tc bridge reject <id> --version <n>` | Declines it. Nothing is posted. |
| `tc bridge merge <id> --version <n> --into <id>` | Folds a duplicate into another candidate. The survivor gains every receipt of the folded one and its version moves, so read it again before approving it; the folded one can never be approved. |

Refusals: `403 VERIFIED_LAUNCH_REQUIRED`, `409 BRIDGE_DISABLED`, `404 RECEIPT_NOT_FOUND`,
`400 BAD_RECEIPT`, `400 RECEIPTS_REQUIRED`, `409 REQUEST_ID_CONFLICT`, `429 CANDIDATE_LIMIT`,
`429 RATE_LIMITED` (twelve submissions a minute from one launch, whatever becomes of them),
`400 UNKNOWN_CANDIDATE_KIND`, `400 CANDIDATE_TEXT_REQUIRED`, `413 CANDIDATE_TOO_LONG`,
`400 CANDIDATE_NOT_DISPLAY_SAFE`; and for the Master `404 CANDIDATE_NOT_FOUND`,
`409 VERSION_CONFLICT`, `409 REQUEST_ID_REUSED`, `409 ALREADY_DECIDED`,
`409 RECEIPTS_DO_NOT_HOLD`, `409 NOT_DISPLAY_SAFE`, `400 REQUEST_ID_REQUIRED`,
`400 EXPECTED_VERSION_REQUIRED`, `400 MERGE_TARGET_REQUIRED`, `409 MERGE_TARGET_NOT_OPEN`.

`tc candidate` works in any pane, but a pane is told of it only once the operator has switched
that on (`POST /api/bridge/operator/candidate-primer`, below). The switch is off by default and
can be turned on only while the bridge is enabled; switching the bridge off takes the verb out
of the list again. A pane's instructions are written when it launches, so the switch reaches
each session at its next launch.

The switch changes one thing: the verb list in the `## TangleClaw Ecosystem` section of a
session's opening context. It changes no file. The carriers TangleClaw writes into a project
(`CLAUDE.md`, `AGENTS.md`, `.codex.yaml`, `.aider.conf.yml`) hold the same verb list whatever the
switch says, because two of them are tracked and none may hold a fact of one install.

That section has a cap of 2820 characters with the switch on (2800 without). A session whose
section would run past it is rendered as if the switch were off, and is not told of the verb.
That is logged as a warning with the project id, the length and the cap, and the operator's
status shows the last time it happened (`candidatePrimerOmitted`). `candidatesPrimed` is what
the operator asked for, not what any one pane was told.

## Server notifications

Three typed notifications go straight to the helper's mailbox, without the Master. They are
transport control the server writes: each comes from a fixed template that takes only a project
name or a count the server resolved, never anything a session or the operator typed.

| Type | Raised when | Bound to |
|---|---|---|
| `work-blocked` | a lane's workload receipt enters `blocked`. A lane that stays blocked and reports again is not a new event. | that workload receipt |
| `operator-needed` | the Medusa watchdog raises an exchange between sessions to its operator rung. Since #2086 that includes ordinary mail left long enough. The sentence says why it was raised (unread, read and unanswered, held by configuration, stalled), from the watchdog's own reason. Never the bridge's own send to a project. | that exchange |
| `fleet-idle` | the fleet is seen to become idle: every live lane finished and clear | the episode: when it began and which lanes were in it |

- **Found, not pushed.** Nothing calls the bridge when an event happens. The gateway's pass
  reads the records that are the events and enqueues a notification for each that has none,
  under a key naming that record. One that could not be enqueued is found again on the next
  pass, for up to 24 hours after its event; one that was is never made twice.
- **No backlog.** Only events from after the bridge was last enabled are considered, and none
  from while it was disabled. Enabling records the time, and nothing looks behind it.
- **`fleet-idle` fails closed.** The fleet must be non-empty, and every live lane must be at a
  known launch with a current receipt and read `AVAILABLE` in the same lane composition the
  fleet roster uses: a fresh `complete`, `safe-to-clear` receipt of the live launch with the
  engine at rest. A lane that is working, waiting, blocked, stale or unknown means the fleet is
  not idle.
- **One notice per idle episode.** An episode is one spell of an idle fleet with the same
  members, notified when it is seen to begin. Three readings are kept apart:
  - *idle*: every lane finished and clear, as above. Only this begins an episode.
  - *busy*: a lane is working, waiting, blocked, held or stopped, or there are no lanes. Only
    this, or a change of members, ends an episode.
  - *unknown*: a lane's engine has not been observed at rest yet, an observation lapsed, or a
    receipt went stale. It neither begins nor ends one: not knowing is not idle, and it is not
    evidence that anything changed.

  So a lane that stays finished and reports again, or whose reading lapses and returns, is the
  same episode. After the bridge is enabled, or the server restarts, the first reading that
  says anything is taken as it is and not announced; for the first seconds after a restart
  every reading is unknown, because no engine has been observed at rest yet.
- **Not kept for a late helper.** A notification nobody collected is let go after its limit
  (see Retention), so a helper that attaches late does not post stale news ahead of current
  answers. An item that was let go cannot be acknowledged afterwards.
- **An episode's identity outlives a restart.** Its notice is the record of it. When the
  server starts and finds the same lanes idle, that is the episode resumed, not a new one.

`release-action-needed` and `certification-state-changed` remain reserved, with no producer.

## The helper's routes

For the chat helper only, authorised by its scoped token in `x-tangleclaw-bridge-helper-token`.
The token opens these six routes and nothing else, and only for a request made directly from
this machine (`403 LOOPBACK_REQUIRED` otherwise); only its SHA-256 is stored. Every write
also carries `x-tangleclaw-bridge-nonce`, 16 to 128 URL-safe characters, never used before.

| Route | Does |
|---|---|
| `POST /api/bridge/helper/preflight` | `{authorId, spaceId, channelId}`. Reads only, takes no nonce, and answers while the bridge is disabled: `tokenLive`, `bridgeEnabled`, `allowlistSet`, `allowlistMatch` (one answer for all three ids together) and `circuit` (`open` or `closed`). No id, token or text comes back. Six a minute. |
| `POST /api/bridge/helper/inbound` | Hands over one operator message: `externalId`, `authorId`, `spaceId`, `channelId`, optional `threadId` and `replyToExternalId`, and `text` (at most 8000 characters). `202` when stored, `200` for a replay. |
| `POST /api/bridge/helper/outbound/claim` | Collects what to post next, oldest first: optional `{limit}`, 1 to 20, 10 by default. Each item comes with the chat context to post it in and a lease. |
| `POST /api/bridge/helper/outbound/:id/parts` | `{leaseId, partIndex, partCount, externalId}`: one message the chat made for the item, reported as soon as it is made. |
| `POST /api/bridge/helper/outbound/:id/ack` | `{leaseId, parts, partCount}`: the lease the item was claimed under, and the chat's id for every message the item was posted as, in order, with how many there are. It seals the item. Exact: repeating it changes nothing, and a different set is refused. |
| `POST /api/bridge/helper/outbound/:id/failure` | `{leaseId, reason, parts?, partCount?}`: the helper could not post the item, why, and which parts did post. |

Refusals: `403 LOOPBACK_REQUIRED`, `429 RATE_LIMITED` (from one token, a minute: 120 inbound
messages, 600 outbound requests, six preflights, each counted apart; a request over the bound
writes nothing and spends no nonce, so it can be sent again as it is), `401 HELPER_TOKEN_REQUIRED`, `409 BRIDGE_DISABLED`, `400 NONCE_REQUIRED`,
`409 NONCE_REUSED`, `409 ALLOWLIST_NOT_SET`, `403 NOT_ALLOWLISTED`, `400 BAD_INBOUND`,
`413 INBOUND_TOO_LONG`, `409 EXTERNAL_ID_MISMATCH`, `409 EXTERNAL_ID_COLLISION`, `400 BAD_CLAIM`,
`400 LEASE_REQUIRED`, `404 LEASE_NOT_FOUND`, `403 LEASE_NOT_YOURS`, `400 BAD_PART`,
`400 BAD_ACK`, `400 BAD_FAILURE`, `409 PART_MISMATCH`, `409 PART_OUT_OF_ORDER`,
`409 PART_ID_COLLISION`, `409 ACK_MISMATCH`, `409 LEASE_LAPSED`,
`409 BRIDGE_CONFIGURATION_BLOCKED`, `409 ACK_NOT_APPLIED`, `404 OUTBOUND_NOT_FOUND`
(an id that could not be an item's).

`409 ACK_NOT_APPLIED` is also the answer to an acknowledgement, in order in every other way,
for an item that is no longer waiting to be delivered: withdrawn or set aside in the meantime.
An item is recorded as delivered only when its own row moved to delivered, or was already in
exactly that state under the same messages. Nothing else is reported or audited as a delivery.
For an answer, the route's own change is undone with it: the route stays `released`. The server
log records each such refusal as `Bridge acknowledgement was not applied`, with the item's id,
the route's id when it has one, and the outcome. The helper reads it as it reads a lease that
is no longer its own: it stops asking under that lease and goes on to the next item.

Acknowledging an answer marks it delivered, settles its lease, and closes and clears its route
in one transaction.

### Claims and leases

There is no way to read the mailbox without claiming from it. A claim hands each waiting item
over under a **lease**: an id, the item, the helper token it was issued to, when it was issued
and when it lapses. The window is two minutes.

| Field of a claimed item | Meaning |
|---|---|
| `outboundId`, `kind`, `sourceLabel`, `text`, `inReplyTo` | What to post and where. |
| `digest` | SHA-256 of the text that was handed over. |
| `leaseId`, `issuedAt`, `expiresAt` | The lease. |
| `leaseState` | `live`, `used` or `lapsed`. Post an item only while its lease is `live`. |
| `postedParts`, `partCount` | The chat's id for each part already recorded for the item, in order, and how many parts it has (`null` until one is recorded). Carry on after them. |
| `attempts` | How many times the item has been handed over: one for each lease ever issued for it. A claim repeated under its nonce hands nothing over and is not counted. |

- **One live lease per item.** An item somebody holds is not handed over again.
- **A lapsed lease returns its item.** If no acknowledgement arrives inside the window, the
  lease lapses and the next claim hands the item over under a new one.
- **Bound to the token.** A lease is good only from the helper token it was issued to:
  `403 LEASE_NOT_YOURS`. Replacing or revoking the token lapses everything it held at once.
- **The binding is judged before anything is said about the item.** Every write about an item
  (a part, an acknowledgement, a failure) names a lease. If no such lease exists for that item
  the answer is `404 LEASE_NOT_FOUND`; if it was issued to another token, `403 LEASE_NOT_YOURS`.
  Both are the same whether the item is waiting, delivered, set aside, let go, or never
  existed, so a caller that does not hold the lease learns nothing about the item.
- **A lease that is no longer live is told only that.** Lapsed by time, settled when its item
  was set aside, replaced with its token: every write under it answers `409 LEASE_LAPSED`, on
  every route, whether its item was delivered by another lease, set aside, withdrawn, let go
  or is still waiting. Having held a lease once is not holding it now. No helper route ever
  says what became of an item.
- **The one exception is the lease that sealed a delivery.** It is that delivery's receipt,
  kept as long as the item is, so the helper that made an acknowledgement can always repeat it
  exactly and learn that it landed. It answers through the acknowledgement alone, only for
  exactly what it sealed (anything else is `409 ACK_MISMATCH`), and only to its own token. A
  lapsed lease is removed after a day.
- **A claim is named by its nonce.** Repeating a claim with the same nonce, token and request
  returns the leases it issued the first time and issues nothing. A lease that is no longer
  live comes back as its id and `leaseState` alone: no text, no posted parts, no count. The same nonce with a different
  request or token, or one another helper write has used, is `409 NONCE_REUSED`. This is the
  one helper write whose nonce may be seen twice.
- **A live lease holds its item past its retention limit.** See Retention.

### What a reply answers

The bridge records **every** message the chat made for an item, by the chat's own id, against
that item: its position, how many there are, and what the item was (its kind, and its route,
candidate and type where it has them). That description is taken from the item, never from the
helper. The first message's id stays the item's reference.

- **Each part is recorded as soon as it is posted,** through `.../parts`. From that moment a
  reply to it is known for what it answers, and a later claim of the item says the part is
  already posted. Parts are recorded in order. Repeating one exactly changes nothing; a
  different message for a part already recorded, or a different count, is `409 PART_MISMATCH`;
  a part ahead of the next one is `409 PART_OUT_OF_ORDER`.
- **The acknowledgement seals the whole set.** `partCount` ids, each a chat id, none twice, at
  most 32, agreeing with every part already recorded. A malformed set is `400 BAD_ACK`; one
  that disagrees with the record is `409 PART_MISMATCH`. Neither delivers anything.
- An id the bridge already knows, as a part of another item or as a message the operator sent,
  is `409 PART_ID_COLLISION`. An operator message carrying a posted message's id is
  `409 EXTERNAL_ID_COLLISION`.

When an operator message replies to a recorded message, the bridge fixes what it answers on the
new route, at acceptance, and never changes it: the item, its kind, its candidate id and kind
or notification type, its route, the message replied to, the item's first message, and the
part's position and count. A message that replies to something the bridge does not know has no
such record and is handled as before.

Nothing here sends the reply anywhere. Like every inbound, it waits for the Project Master,
and what follows is only the destination the bridge suggests with it.

| The reply is to | Suggested for | Because |
|---|---|---|
| The operator's own earlier message | That message's destination | Reply inheritance, as before. |
| Any part of an answer whose route is still held | That route's destination | Reply inheritance. Any part, not only the first. |
| Any part of a milestone, another candidate or a notification | The Project Master, resolved by `outbound-correlation` | The item has no route: the durable record of the posted message supplies the correlation. The Master reads the route and sees what it answers. A conversation pin does not divert it. |
| Any part of an answer whose route has since been removed | The Project Master, resolved by `outbound-correlation` | There is nowhere left to inherit; what it answered is still on record. |
| Any part of a question the Master asked | The Project Master, as `question-answer` | It answers the Master's question, whatever has become since of the message the question was about. |
| A message the bridge does not know | Resolved as an unaddressed message | Nothing is invented about what it answers. |

A leading `@name` is the suggestion instead of any of these when it names exactly one current
destination, and what the message answers is recorded all the same. An `@name` that names nothing, or more
than one thing, is never guessed at: the route waits for the Master with `address-unresolved`,
`address-ambiguous` or `address-out-of-reach`, still knowing what it answers. A reply changes nothing about the candidate it answers and releases nothing again.
`tc bridge read <route-id>` shows what a route answers, and the Master's notice says so in
fixed words.

### When the helper cannot post an item

The helper discards nothing. What it cannot post it reports through `.../failure`, with a
reason from a closed list and the parts that did post. Any other reason is `400 BAD_FAILURE`.

| Reason | Kind | What the bridge does |
|---|---|---|
| `transient` | A retry may fix it | Records it. The item stays waiting under its lease. |
| `outcome-unknown` | A retry may fix it | The same. The helper retries under the same chat nonce. |
| `rejected-by-chat` | This item will not post | Sets the item aside. |
| `outcome-unverifiable` | This item will not post | Sets the item aside. Either a post may have landed and can no longer be checked (the helper holds it as `uncertain`), or Discord refused it in a way the helper could not place (nothing landed, and the helper holds nothing). |
| `part-conflict` | This item will not post | Sets the item aside. The bridge's record of its parts and the helper's disagree. |
| `chat-channel-missing`, `chat-guild-missing`, `chat-permission-denied`, `chat-auth-refused` | The chat is closed to the bot | Sets the item aside and opens the configuration circuit (below). |

An item **set aside** (`blocked`) keeps its text and is handed to nobody. The lease it was held
under is settled. The bridge raises one `operator-needed` notice, a fixed sentence, for each
time an item is set aside. For a refusal of one item, that notice is never itself set aside: a
helper that cannot post it keeps trying. (When the chat is closed to everything, whatever is in
hand is set aside, a notice included; see the configuration circuit below.)

Only the Project Master or the signed-in operator decides what happens next:

- **Requeue** puts the item back. The next claim hands it over with the parts already posted.
- **Withdraw** lets it go for good and drops its text. An item is withdrawn only when no helper
  holds it: with a live lease the answer is `409 OUTBOUND_IN_FLIGHT`.

### The configuration circuit

When the helper reports that the chat itself will not take posts (the channel or server is
gone, the bot may not post there, its token is refused), setting aside one item after another
would empty the mailbox into a pile and raise a notice for each. Instead, in one transaction:

- the item in hand is set aside;
- **one episode opens.** At most one is ever open; a second such report while it is open sets
  its own item aside and opens and raises nothing;
- **one `operator-needed` notice is recorded** for the episode.

While an episode is open, **every claim answers `409 BRIDGE_CONFIGURATION_BLOCKED`** with the
episode, its reason and when it opened. That answer is given before the claim touches
anything: no lease, no hand-over count, no nonce, no expiry, no notice, no audit row. What is
queued stays queued, exactly as it was.

The episode's notice cannot be posted, since nothing is handed over. It is on the record and
shows in `tc bridge status`, in `GET /api/bridge/operator/status` (`configurationCircuit`), in
the audit, and as a warning in the server log, so the operator learns of it without the chat.
The dashboard's Operator Bridge panel shows it too, with the two ways to reset it. Until cutover
the interim Discord procedure is also still in force.

The gateway tells the Project Master of an open episode through the Master's Medusa listener,
at once and then every five minutes, until the Master acknowledges it with
`tc bridge circuit ack <episode>`. Both the telling and the acknowledgement belong to one Master
generation, and the episode records which. A Master launched afterwards is told on the
gateway's next pass, whether or not the one before it acknowledged, and until it acknowledges
for itself; the five minutes pace only repeats to the same Master. The record is in the store,
so a restart changes none of this. The notice is a fixed sentence naming the episode and its
reason. Acknowledging does not close the episode. The Master's own rules tell it to report the
episode to the operator at the workstation and that, while it is open, **a release is not a
delivery receipt**: what it answers or releases only queues. A Master with no listener cannot
be told this way; `tc bridge status` still shows the episode, when the Master was last told,
and whether the Master asking has acknowledged it.

An episode does not close by itself, however long it lasts. Once the chat's configuration is
put right, the Project Master (`tc bridge reset --requeue` or `--withdraw`) or the signed-in
operator (`POST /api/bridge/operator/circuit/reset`, `{requestId, decision}`) resets it. The
reset closes the episode, puts back or withdraws every item it set aside, and withdraws the
episode's notice. Items set aside for their own reasons are not the reset's to decide.
`409 CIRCUIT_NOT_OPEN` when there is none.

Closing a route withdraws everything released for it and not yet posted, under the same rule.
What was delivered is history and is not unsent. An item set aside still has its retention
limit and is let go when it passes.

`OUTBOUND_NOT_READY` is retired. An item is waiting, delivered or let go, and each of the last
two has its own answer, so no request could ever have reached that refusal.

## The operator's routes

Every `POST`, `PUT`, `PATCH` and `DELETE` here must come from an identified caller before its route runs: see "Who may write" in `docs/configuration-reference.md`. These routes then ask for more than that:

For the operator only, **signed in with an account session**. A request that merely looks like
the dashboard while the auth gate is open is refused with `403 OPERATOR_SESSION_REQUIRED`: on
an install with no accounts, bridge policy cannot be changed at all. Every change is audited
with the signed-in user. The helper token and the allowlisted ids are never written to the
audit.

### The dashboard panel

The signed-in operator works these routes from the dashboard: global settings, section
**Operator bridge (Discord)** (`public/operator-bridge-panel.js`). It calls these routes and no
others, and adds no authority of its own: a browser with no account session is shown only that
it has to sign in, and nothing of the bridge.

| Control | What it does |
|---|---|
| Enable / Disable the bridge | Enabling asks first. Disabling asks nothing and acts at once: it is the kill switch. |
| Forget a nickname | Lists every nickname with who set it, when, and on which of your messages. Removing one asks first. Nicknames are set by asking the Master in the chat. |
| Take a project out of reach / Put it back | Lists every reachable project and every one opted out, and says how the Master's scope reads. Taking one out of reach asks nothing and acts at once. Putting one back asks first. |
| Set the allowlist | The exact author, server and channel, as Discord's numbers. It names all three back before it sends. |
| Create or replace the helper token | Shows the value once. Copying is a button the operator presses; nothing is copied without it. The page keeps the value in no storage, no URL and no log, and it is gone when dismissed or when settings closes. It goes into the helper's Keychain through `bin/tc-bridge-helper set-secret helper`, which reads it from standard input. Created only over https, from this machine itself, or through a proxy on this machine that says the browser came over https; from anywhere else it is refused with nothing created (`403 SECURE_TRANSPORT_REQUIRED`). |
| Revoke the helper token | Only once the bridge is disabled: rolling back is disable first. |
| Telling sessions of `tc candidate` | On asks first and needs the bridge enabled. Off is always available, including while the bridge is disabled, when the panel says the switch is set and not in effect. |
| Reset the circuit | Two buttons, one for each decision: put back what was set aside, or withdraw it. There is no reset without one. |
| Put back / Withdraw, on each item set aside | By item, with what it is and why it is held. Never its text. |
| Withdraw, on each thing queued with no open route | Everything that would still be posted after every route was closed: an undecided candidate, an approved milestone not yet collected, a server notice, an item set aside. By id, kind, state and age. Asks first. Disabling the bridge withdraws none of them; a rollback has the operator withdraw each. |

A write that must not happen twice (a reset, a put-back, a withdrawal) carries a request id. If
its answer is lost, pressing the control again sends the same id, and the server answers the
repeat without doing it twice. Once the server has answered, yes or no, the next press is a new
request.

| Route | Does |
|---|---|
| `GET /api/bridge/operator/status` | Whether it is enabled, the allowlist, whether a helper token exists, the Master generation, aliases, each nickname with who set it and on which message (`nicknames`), what the bridge may reach (`reach`: how the Master's scope reads, the reachable projects, and the projects opted out), pins, how many routes are open, in each state and since when (`openRoutes`, `openRoutesByState`, `oldestOpenRouteAt`: counts and a time, no text), what is waiting (`waitingForHelper`, which counts an open episode's notice), how many items are set aside (`setAside`), each item set aside by id, kind and reason and never its text (`setAsideItems`), everything queued that no open route owns, undecided candidates included, by id, kind, state and age and never its text (`routelessItems`), whether sessions are being told of `tc candidate`, what the switch was last set to whether or not the bridge is on for it to take effect, and the last launch that was not told (`candidatesPrimed`, `candidatePrimerSetting`, `candidatePrimerOmitted`), whether the Master can be told and how many routes it has not been told of (`masterListener`, `routesMasterNotTold`), the open configuration episode if there is one (`configurationCircuit`), and the arrivals the gateway dropped since the server started, each with its reason. |
| `POST /api/bridge/operator/allowlist` | Sets the one `authorId`, `spaceId` and `channelId` accepted. |
| `POST /api/bridge/operator/helper-token` | Replaces the helper token. The value is in this response and nowhere else. |
| `DELETE /api/bridge/operator/helper-token` | Revokes it. |
| `POST /api/bridge/operator/enable` | Enables the bridge. Refused until the allowlist is set, a helper token exists and the Master is a switchboard participant (`409 MASTER_LISTENER_OFF`). Audited with the signed-in user. Starts the gateway's listener. |
| `POST /api/bridge/operator/disable` | Disables it and stops the listener. |
| `POST /api/bridge/operator/candidates/:id/withdraw` | `{requestId}`. Withdraws a candidate nobody has decided: it will never be approved or posted. For clearing what is queued when the bridge is wound down, since the Master's own decisions are refused while it is disabled. Idempotent on the request id, audited. `404 CANDIDATE_NOT_FOUND`, `409 NOT_WAITING`, `409 REQUEST_ID_REUSED`. |
| `POST /api/bridge/operator/candidate-primer` | `{primed}`, true or false: whether every pane is told of `tc candidate` at its next launch. Switching it on is refused `409 BRIDGE_DISABLED` while the bridge is off; switching it off is always taken. Audited. |
| `POST /api/bridge/operator/circuit/reset` | Closes the open configuration episode. `{requestId, decision}`, where `decision` is `requeue` or `withdraw`. |
| `POST /api/bridge/operator/outbound/:id/requeue`, `.../withdraw` | Puts a set-aside item back, or withdraws one that has not been posted. `{requestId}`. The same decisions the Master has. |
| `POST /api/bridge/operator/aliases`, `DELETE .../aliases/:alias` | Sets or removes a nickname, for putting right what was set in conversation. The name may be written with its `@` or without. `master`, `set`, `rename` and `forget` are reserved (`409 ALIAS_RESERVED`), the destination must be one the bridge may reach, and a new name may not be a number or a reachable project's name or slug (`409 NICKNAME_COLLIDES`). Recorded as the operator's. |
| `POST /api/bridge/operator/optouts`, `DELETE .../optouts/:projectId` | Takes a project out of reach of the bridge, or puts it back. `{project}` is a project id (`400 UNKNOWN_PROJECT` otherwise); putting back one that is not out is `404 OPTOUT_NOT_FOUND`. Audited. |
| `POST /api/bridge/operator/pins`, `DELETE .../pins/:pinId` | Sets a pin for one conversation, or for every conversation when no `conversationKey` is given; revokes any active pin, the Master's included. |

## Storage

Schema v52 added these tables. `medusa_exchanges` is unchanged: a message the bridge sends is an
ordinary tracked exchange, and what makes it the bridge's is a row in `bridge_route_proofs`.

Schema v53 changed two of them. `bridge_outbound` admits the `status` kind, and
`bridge_route_proofs` records the project, workspace, session and launch a sent message went to
and can no longer be updated. A CHECK cannot be altered in place, so the v53 migration rebuilds
those two tables and carries every row and row id over. It first proves the store is a sound
v52 store and refuses one with a bridge table missing or misshapen, before touching anything.
The v53 shape is a superset of v52's: a server from before v53 that meets a v53 store still
accepts it.

Schema v54 added `bridge_outbound_claims`, `bridge_outbound_leases`, `bridge_outbound_parts`,
`bridge_route_reply_context` and `bridge_config_circuit`, the `blocked` state and its reason on `bridge_outbound`, the
`outbound-correlation` resolution on `bridge_routes`, and a CHECK on
`bridge_helper_tokens` tying a revoked token to the time it was revoked. Those three tables are
rebuilt with their rows and row ids carried over, after the store is proven a sound v53 store. A v53 store
holding a token marked revoked with no time recorded is refused, and left at v53 untouched. The
v54 shape is a superset of v53's.

v54 also carries what the Master's questions rest on. `bridge_questions` holds each question's
standing; `bridge_outbound`, `bridge_outbound_parts` and `bridge_route_reply_context` gain the
`question` kind and the id of the question an item asks. `bridge_aliases` records who last
changed a nickname, when, on which operator message when the Master changed it, and the name
as it was typed; rows from an earlier store come through with those empty. `bridge_launches` holds each
consented launch and how it stands. `bridge_project_optouts` holds the projects the operator has
taken out of reach, written only by the operator's routes. The store itself holds the rules that must not depend on a caller: one open
question per message, one use of an operator's reply, and a settled question never reopened.

"Superset" is a statement about shape: every object an earlier version required is still there
in the form it required. It is not a way to run an earlier build.

Rolling the bridge back does not go to an earlier build and does not touch the store: it
disables the bridge, stops the helper and closes what is open, on v5.31.0
([runbook](runbooks/roll-back-the-operator-bridge.md)). Putting the previous build back is a
separate, destructive procedure for when v5.31.0 itself cannot run. It returns the store to the
snapshot taken before the upgrade, so everything written since is absent from the active
store, and it keeps the v5.31 store in a quarantine directory without merging it back
([runbook](runbooks/put-back-the-build-before-the-operator-bridge.md)).

v54 also retires `idx_bridge_routes_conversation`, an index v52 created and nothing reads. It
is dropped by the upgrade and again at every boot, and its presence after that fails the shape
check.

| Table | Holds |
|---|---|
| `bridge_settings` | The operator's switches. The bridge is off unless `enabled` is `true`. |
| `bridge_master_credentials` | One row per Master generation: the hash, its status and why it was revoked. |
| `bridge_helper_tokens` | The chat helper's scoped token, hash only. |
| `bridge_nonces` | Request nonces already seen from the helper. |
| `bridge_outbound_claims` | Each claim the helper made: its nonce, the token and a digest of what was asked. Never updated. |
| `bridge_config_circuit` | Each time the chat itself stopped taking posts: why, which item found it, when it opened, and who closed it with what decision. At most one is open. |
| `bridge_outbound_parts` | Every message the chat confirmed, recorded as it is reported, by the chat's own id: the item it is a part of, its position, and what the item was. Never updated, and never removed. |
| `bridge_route_reply_context` | For an inbound message that replies to a recorded message, which one. Fixed at acceptance; leaves with its route. |
| `bridge_outbound_leases` | The lease each item was handed over under. What it was issued for never changes; its state settles once, to `used` or `lapsed`. At most one live lease per item. |
| `bridge_routes` | One row per inbound operator message, unique on the chat's own message id. A replay of the same message returns the same route; the same id with a different body or chat context is refused. |
| `bridge_route_bodies` | The text of a route, held apart so it can be cleared while the route stays. |
| `bridge_route_proofs` | Which Hub message belongs to which route, under which proof, and for a sent message exactly who it went to. Never updated. |
| `bridge_outbound` | What waits for the helper. Each row has its own idempotency key; `hub_id` is optional. At most one `status` row per route. |
| `bridge_candidates` | Facts a session offers the Master. |
| `bridge_candidate_receipts` | The receipts a candidate rests on, each by kind, id and digest. Immutable. |
| `bridge_aliases`, `bridge_pins` | Routing policy. Global pins are the operator's; the Master may hold a conversation pin, and may change a nickname only with an operator message behind it. One pin is active per scope and conversation. A global pin names one conversation, or none, which means all of them. |
| `bridge_audit` | Every bridge write. Never updated; removed only by a compaction. |
| `bridge_audit_anchor` | One row, always: how far compaction has reached, how many audit rows have left in total, and a digest chained across every compaction. It only moves forward. |

The database does not run with foreign keys, so triggers enforce the same integrity: a body, a
proof or a route-bound outbound item needs its route; a candidate-bound item needs its
candidate; a candidate needs its source project; a receipt needs its candidate; a lease needs
its item and the claim it was issued under. Removing a route removes its bodies, proofs and
outbound items, and removing an item removes its leases.

### Retention

`lib/bridge-store.js#prune` removes what has outlived its retention. The gateway runs it once
a day, whether or not the bridge is enabled, and on the gateway's first pass after the server
starts, before any helper request is heard. Revoked pins and helper tokens leave after 90 days.

| Record | Kept for |
|---|---|
| Message text | Until confirmed delivery or close. Not by age. |
| Helper nonces | 24 hours |
| A lapsed lease, and a claim with no lease left | 24 hours after settling |
| The lease an item was delivered under | With the item: it is the receipt of the delivery |
| The record of which posted message belonged to which item | Never removed. It holds ids and no text. |
| What an inbound message answers | With that message's own route |
| Closed routes, with their bodies, proofs and outbound items | 30 days after closing |
| Delivered or dropped outbound items | 30 days, except an item of a route that is still open, which stays with its route; and the record of which chat messages an item was posted as, which is never removed |
| Decided candidates | 30 days, except one that still has an item made from it, which waits for that item to go by its own rule |
| A reply | Never let go while it waits |
| A delivery-failure notice | Let go after 30 days, then kept 30 days |
| An undecided or uncollected `milestone` candidate | Let go after 7 days, then kept 30 days |
| An undecided or uncollected `operator-action-required` candidate | Let go after 30 days, then kept 30 days |
| An uncollected `work-blocked` or `operator-needed` notification | Let go after 7 days, then kept 30 days |
| An uncollected `fleet-idle` notification or route status notice | Let go after 24 hours, then kept 30 days |
| Revoked Master generations | 90 days; the newest generation is always kept, so a number is never reused |
| Audit rows | 90 days, then compacted |

An open route, an undelivered reply, a live lease and the live credential are never removed,
whatever their age.

The record of posted messages is the one thing retention never removes. A reply to a posted
message can arrive at any time, and without the record that reply would be handled as a message
that answers nothing, with nothing to say a correlation had been lost. The rows hold ids and
positions, no text, and one row per posted message.

"Let go" means an undecided candidate is rejected as expired and an uncollected item is
dropped. Something is let go when it has waited strictly longer than its limit. Each one is
audited by itself, with its own id and a fixed reason: `undecided-expired`,
`approved-uncollected-expired` or `uncollected-expired`.

A candidate has two clocks. Waiting to be decided runs from submission; waiting to be collected
runs from approval, which is a new fact about how fresh it is. A milestone can therefore live
up to 7 days undecided and a further 7 approved; an operator action 30 and 30.

An item with a live lease is not let go. The helper was handed it inside its limit and has the
lease's window to say it was posted, so an acknowledgement can cross the limit by at most that
window. A claim lets go of what is past its limit before it issues any lease, so no lease is
ever issued for an item already past it. Once the lease lapses the item is judged like any
other.

Being let go is final. Nothing is let go while a lease on it is live, so the helper that held
it holds only a lapsed lease, and its acknowledgement is refused `409 LEASE_LAPSED` like any
other lapsed lease's. The item is never handed over again. Nothing let go is raised again:
its row and its idempotency key stay until retention removes them, so the event that caused it
remains accounted for.

Three things keep that true however long anything lasts:

- A route records, on the route itself, that it has had its status notice. The notice's own row
  can be let go and removed; the route still refuses a second.
- A settled item of a route that is still open stays with its route. It is removed once the
  route is closed and past its own retention.
- A decided candidate is removed only after every item made from it has gone by its own rule.
  Removing a candidate removes its items, so the candidate waits for them.

A closed route takes its outbound items with it in any state: a route closes only once its
answer has been relayed or abandoned. An audit row of a route that is still open is never
compacted, and neither is any row written after it.

After a compaction a request id older than the retention is no longer remembered, so it could
be accepted again.

The shape of every table, index and trigger is checked at each startup. A store that fails the
check is refused, and the message names each object that is missing or misshapen.

## Code

- `lib/bridge-schema.js`: the DDL and the shape check.
- `lib/bridge-store.js`: reads and writes, including the idempotent, version-checked, audited
  route write.
- `lib/bridge-handoff.js`: minting, hashing and the FIFO handoff. It does not load the store.
- `lib/bridge-principal.js`: when a credential exists and whether a presented one is live.
- `lib/bridge-gateway.js`: accept, resolve, dispatch, reply capture, the periodic pass.
- `lib/bridge-notify.js`: the three typed server notifications.
- `public/operator-bridge-panel.js`: the signed-in operator's panel in the dashboard's global
  settings. Operator routes only.
- `lib/bridge-api.js`: every bridge route, declared with the principal it belongs to. One
  function proves the principal before any handler runs.
- `bin/tc-bridge-receive`: the pane-side reader.
- `bin/tc-bridge-helper` and `lib/bridge-helper/`: the Discord helper, a separate process that
  reaches the server only through the helper's routes.
