# Check watches

*A session registers a watch, and the server reads the check from GitHub about once a minute,
records its result, and sends the watch's project a switchboard message: a **wake** when the check
finishes, an **alarm** when the due time passes without a result. Each message's delivery is read
back from the watch. Every answer says `monitored: true`. There is no screen. (#2323)*

## What a watch is

A watch is a session's request to be told when one named check finishes on one exact commit of a
pull request. It records:

- the project it belongs to, and the session and launch that registered it;
- the repository, the pull request number, the commit (all 40 characters) and the check's name,
  exactly as GitHub shows it;
- a due time, after which silence is itself reported.

The watch belongs to the **project**, not to the launch that registered it, so it is still there
after the session is cleared or relaunched, and after the server restarts.

The repository is not taken from the request. It is the `origin` remote of the project's own
folder, read by the server with `git`, and it must be on github.com. A project whose folder has no
such remote cannot register a watch (`CHECK_WATCH_REPO_UNKNOWN`). This is not a boundary against
the project's own session: a session can write its folder's git config, so it can change which
repository its next watch records.

## The four states

The state is worked out from the record on every read and is never stored.

| State | Means |
|---|---|
| `waiting` | No result is recorded, the last read of GitHub worked (or none has been made), and the due time has not passed |
| `ready` | The recorded result is `success` |
| `failed` | The recorded result is any other conclusion GitHub gives a finished check |
| `unknown` | The server cannot say. `reasons` says why |

**`unknown` is not `failed` and is not done.** A session that reads it must not treat the check as
concluded either way; it reads the check itself. The reasons, of which more than one can hold:

| Reason | Means |
|---|---|
| `past-due` | The due time passed with no result recorded |
| `read-failed` | The last read of GitHub failed, so "still running" cannot be vouched for |
| `cancelled` | The watch was cancelled and is not read again |
| `expired` | The watch stayed unresolved for 24 hours past its due time and is not read again |
| `unreadable` | The record or a time in it cannot be made sense of |

`ready` and `failed` come only from a recorded result. A watch is **open** while it has no result,
is not cancelled and has not expired. A watch past its due time is still open: a late result is
still its result.

## The monitor

The server reads every open watch's check from GitHub itself, on a timer, and records what it
reads. Nobody has to ask.

- **About once a minute.** The timer runs a pass every 60 seconds, and that is what sets the rate:
  one read per watch per minute. A result is therefore recorded up to a minute after the check
  ends, never at the instant it ends. A second guard stops a watch being read twice within 45
  seconds; it only matters when passes come faster than the timer, as after a restart.
- **A result is written once.** The first read that finds the check finished records its
  conclusion, the run's id and when it completed. The watch then reads `ready` or `failed`, is no
  longer open and is not read again.
- **A read that fails writes no result.** The watch reads `unknown` with `read-failed` until a read
  works again. Its history gains one `read-failed` when reads start failing and one
  `read-recovered` when they work, not one per read.
- **Expiry.** A watch still unresolved 24 hours after its due time is read one last time and, if
  that read finds no result, expired: it is not read again, it no longer counts as open, and it
  goes on reading `unknown`, now with `expired`. A result found at that last read wins and is
  recorded instead. A last read that could not reach GitHub does not hold the expiry back. To
  watch the check again, register a new watch.
- **Then it tells the project.** The same pass that records a result sends the wake, so a session
  is woken up to a minute after the check ends. See The two messages.

The read is one `gh api` call made under **the server's own GitHub identity**, for whatever
repository the project folder's `origin` named when the watch was registered. Nothing limits which
repository that is. What is limited is how much the server reads with nobody asking: see Limits.

## The two messages

A watch sends its project at most two messages, each at most twice.

| Message | Sent when | Says |
|---|---|---|
| **wake** | a result is recorded | the check, the pull request, the repository, the exact commit, the conclusion, and that it did not pass when it did not |
| **alarm** | the due time passes with no result | the same check and commit, the due time, that the watch reads `unknown`, and until when it is still read |

A result recorded after the alarm still sends the wake. A cancelled watch is sent nothing more.

**Who gets it.** The project's one active session whose switchboard listener is connected. With no
session, with more than one, with a session that has no listener, or with a listener that is not
connected at that moment, nothing is sent and no request id is spent: the watch's history gains
`wake-undeliverable` or `alarm-undeliverable` once, with the reason, and the message is sent on the
first pass that finds exactly one connected session. A held project is still sent to.

**A late alarm says it is late.** An alarm sent more than two minutes after its due time says so,
names the due time and the time it is sent, and never reads as if it were on time. If the watch has
expired by then, the alarm says when it expired and that it is not read again.

**How it is sent.** The monitor is a switchboard participant of its own, named *Check Watch*. Each
message is a tracked exchange, so it has a delivery receipt. It asks for no reply and reads none:
anything sent to *Check Watch* is dropped. The monitor types into no pane, ends no session and
changes nothing on GitHub.

*Check Watch* listens only while it has somebody to tell: while a watch is open, or owes a message,
for a project that has a connected session, or while a send is waiting on its second attempt. So
the roster shows one more peer only while such a watch exists, and an install with no watch has no
such listener. When it has been stopped, the pass that finds work starts it and the next pass
sends, so the first message after a quiet spell can be a second minute late.

**The marker.** Every message ends with a line `ref: <request id>`. The request id is
`check-watch:wake:<watch id>` or `check-watch:alarm:<watch id>`, with `:2` added on a second
attempt, so both attempts name the same watch and result. A message reaches its recipient before
the Hub has answered the send, so in the ordinary case it is this line, read when the message
arrives, that ties the Hub's message to the send. It binds only when the id names a send the
monitor made, the message came from the workspace that send was made from, and it reached the
workspace that send was addressed to. Nothing is ever matched by sender, recipient, order or time
alone.

**One second attempt, never a third.** When the outcome of a first send was never learned (the
Hub's answer was lost, or the server stopped before it came), the monitor sends the message once
more. It does so only when the recipient's listener has been connected for **two minutes without a
break**, counted from the later of the moment the outcome became uncertain and the moment that
listener last connected, and no marked arrival has tied the first send to a Hub message in that
time. Any disconnection starts the two minutes again. The second message says it is a second
attempt. A send the Hub **refused** is final and is never sent again.

The two minutes are measured from `listeningSince`, the time a listener last reached `listening`.
It is one more key in a listener's status, an ISO time while listening and `null` otherwise, and so
also in the six answers that carry that status: `GET <prefix>/status`, `POST <prefix>/toggle` and
`POST <prefix>/read`, under each of `/api/sessions/:project/medusa` and `/api/master/medusa`.

**Closing.** A message its recipient acknowledges closes its own exchange. One that was delivered
and never acknowledged is closed by the monitor 24 hours after it was sent; a read or an
acknowledgement made after that is still recorded and still shows. A send that never got a Hub
message is left open.

## What became of a message

Every read of a watch carries `delivery.wake` and `delivery.alarm`. Each has a `state`, the
`attempts` made (one or two, each with its own state, its exchange and the workspace it went to),
`secondAttempt`, and `undeliverable` (the code and time of a recorded "nobody to tell", or `null`).
The state is worked out from the switchboard's own facts on every read, never from what the monitor
believed when it sent.

| State | Means |
|---|---|
| `not-owed` | The message does not exist yet: no result (wake), or the due time has not passed or a result came first (alarm). Also a cancelled watch |
| `owed` | It exists and no send has been made yet |
| `undeliverable` | It is owed and the project had nobody to send it to; it is sent when it has |
| `refused` | The Hub declined the send. Final |
| `unconfirmed` | A send was made and there is no proof the Hub ever took it |
| `accepted` | The Hub took it |
| `arrived` | It reached the recipient's listener |
| `read` | The recipient fetched it from its inbox |
| `acknowledged` | The recipient marked it handled |

With two attempts the state is the furthest either got. `read` and `acknowledged` count only when
the recipient session itself did it: the dashboard marking a message handled leaves it `arrived`.
The watch's history also keeps `woke` or `alarmed`, once, when the first send was made, with a code
for how that send stood at that moment (`accepted`, `uncertain` or `refused`); what became of the
message afterwards is in `delivery`, not in that code. `tc check show` prints the history; the
`delivery` states are in the route's answer.

## Who may do what

| Who | May |
|---|---|
| A verified live launch | register a watch for its own project; cancel a watch of its own project; read |
| A project that shares a group with the watch's project | read |
| The Operator | read |
| Anyone else | nothing. A watch they may not read does not exist for them (`404`) |

"Verified live launch" means the request carries `x-tangleclaw-project-id` and
`x-tangleclaw-launch-id` of that project's active session; `tc` sends them. The Operator cannot
register or cancel a watch (`CHECK_WATCH_LAUNCH_ONLY`): a watch says which project's session is to
be woken, and only that project can say it wants to be. A held or stopped lane may still register,
read and cancel: a watch changes nothing outside its own record.

No answer carries a launch id.

## The routes

```
POST /api/tc/check-watches               {prNumber, headSha, checkName, dueInMinutes}   a launch, for its own project
GET  /api/tc/check-watches[?projectId=]  a project's watches, newest first, each with its state
GET  /api/tc/check-watches/:id           one watch, its state and its history
POST /api/tc/check-watches/:id/cancel    {}                                             a launch of the watch's project
```

They are part of the unversioned `/api` family and refuse with its `{error, code}` body. A launch
that sends no `projectId` reads its own project's watches; the Operator must name one. A list
shows the newest 50 and says how many there are in `total`.

`dueInMinutes` is a whole number of minutes from now, counted on the server's clock. A time named
by the caller is not taken.

## From a pane: `tc check`

```
tc check watch <pr> --sha <sha> --name <check> --due <minutes>
tc check list [--project <id>]
tc check show <watch>
tc check cancel <watch>
```

`watch` prints the new watch's id. `list` shows the pane's own project's watches, or those of the
project named, if this project shares a group with it. `show` adds the last read of GitHub and the
watch's history. A refusal exits 2 with the server's code and words; a malformed command exits 1
before any request. The verb is not in the list every pane is primed with: `tc` with no verb lists
it.

## Limits

- **Every watch has a due time**, from 1 minute to 24 hours ahead (1440 minutes).
- **A project holds at most 20 open watches**, and one open watch per check name on a commit. A
  watch that has its result, was cancelled or expired frees its place.
- **A check name is at most 100 characters**, with no surrounding space or control character.
- **The server reads at most 30 watches in one pass, across every project**, at most 4 at a time.
  With more than 30 open watches due a read, the ones read longest ago go first and the rest wait
  for a later pass, so every watch is still read but less often: 60 open watches are each read
  about every two minutes. The server log says when this starts and when it stops.
- **A watch is read for at most 24 hours past its due time**, then expired (see The monitor).
- **Neither table is pruned.** `check_watches` and `check_watch_facts` keep every watch and every
  fact of its history. The limit of 20 bounds open watches only, so the tables grow with use.
- **A duplicate message is possible.** If the Hub accepted the first send, and no marked arrival
  was tied to it within two uninterrupted connected minutes, the second attempt is a second message
  for one result. Both carry the same watch id and result on their marker line, and the second says
  it is a second attempt.
- **The marker and the recipient's inbox cannot be written together.** A marked message reaches
  the recipient's listener, which holds mail in memory, and the monitor then ties its Hub id to the
  send in the store: two steps, not one transaction. If the server stops between them, the store
  does not know the message arrived; after the restart the send still has no Hub id, and unless the
  Hub delivers that message again the second attempt is sent although the first was delivered. That
  is a duplicate, counted under the limit above; it is never a false receipt and never a lost wake.
- **A wake can still be lost** if both attempts were never taken by the Hub or never delivered.
  The read then says `unconfirmed` and the session finds the result by reading its watch. The same
  holds when the session the first send went to has ended before a second attempt could be made:
  the second attempt goes only to the listener the first was addressed to, and a session that
  replaces it is not sent the message.
- **Never a false receipt:** nothing is tied to a send except by that send's own marker, checked
  against the sender it came from and the recipient it was addressed to. The Hub takes a message's
  sender as stated, so this holds against other sessions of this install, which can send only as
  themselves, and not against something that talks to the Hub directly.
- **Up to one pass late** (60 seconds), and a second when *Check Watch* had to be started first.
- **A Hub that restarts loses the messages it holds.** That is read from the Hub's code, where held
  messages are kept in memory, and has not been measured. The second attempt is what covers it.
- **A refusal is final even when it is the Hub's mistake.** A send to a recipient whose connection
  the Hub has just seen close is refused at once and is not sent again (#2370 describes one such
  moment after a reconnect).
- **At most 30 first sends in one pass**; the rest are sent by the next. A pass waits 15 seconds
  for the Hub to answer a send and then goes on; the answer, if it comes, is still recorded.
- **Exchanges are not pruned either**, and one whose send was never confirmed is never closed.
- **Registering reads the project folder's `origin` with `git`**, bounded at four seconds. A read
  that does not finish refuses the registration (`503 CHECK_WATCH_REPO_UNREADABLE`); nothing was
  registered, and it can be repeated. The same code answers when the folder or `git` itself is
  missing, and says that repeating will not help.
- **Nothing checks that the pull request exists, that the commit is its head, or that a check of
  that name ever runs.** A watch on a name GitHub never reports reads `waiting` until its due time,
  `unknown` after it, and is expired 24 hours later.

## Refusal codes

| Code | Status | When |
|---|---|---|
| `CALLER_NOT_VERIFIED` | 403 | Neither the Operator nor a verified launch |
| `OPERATOR_UNVERIFIABLE` | 503 | The install cannot verify an Operator request; sign in and repeat |
| `CHECK_WATCH_LAUNCH_ONLY` | 403 | The Operator tried to register or cancel |
| `CHECK_WATCH_MALFORMED` | 400 | A pull request number, commit, check name, project id or watch id that is not one |
| `CHECK_WATCH_DUE_OUT_OF_RANGE` | 400 | `dueInMinutes` missing, not a whole number, under 1 or over 1440 |
| `CHECK_WATCH_REPO_UNKNOWN` | 409 | The project's folder has no `origin` remote on github.com |
| `CHECK_WATCH_REPO_UNREADABLE` | 503 | The folder's `origin` could not be read in time, or the folder or `git` is missing |
| `CHECK_WATCH_DUPLICATE` | 409 | The project already has an open watch on that check of that commit; `watchId` names it |
| `CHECK_WATCH_LIMIT` | 409 | The project already has 20 open watches |
| `CHECK_WATCH_PROJECT_NOT_FOUND` | 404 | No such project, or none whose watches the caller may read |
| `CHECK_WATCH_NOT_FOUND` | 404 | No such watch, or none the caller may read |
| `CHECK_WATCH_NOT_OWNER` | 403 | A project that may read the watch tried to cancel it |
| `CHECK_WATCH_CANCELLED` | 409 | The watch is already cancelled |
| `CHECK_WATCH_UNAVAILABLE` | 503 | The server could not answer; read the watches again before repeating |

## Where it lives

`lib/check-watch-state.js` (the states, the limits, the codes), `lib/check-watch-store.js` (the
records), `lib/check-watch-api.js` (the routes' handlers and the delivery read),
`lib/check-watch.js` (the monitor: the reads, the two messages, the marker and the second attempt;
started and stopped by `server.js`, whose arrival observer hands it every received message),
`lib/github-checks.js` (the reader of a commit's check), the tracked send in `lib/medusa-send.js`
with its exchanges in `lib/medusa-exchanges.js`, and the `check` verb in `lib/tc-verbs.js`.
