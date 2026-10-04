# Medusa wake monitor: scale and lifecycle measurements

Measurements for #2086. Regenerate the tables with `node scripts/medusa-wake-matrix.js`.

**This revision supersedes the first one.** The first measurement (2026-10-04, `main` at
`4abe838d`) modelled a pane capture as one tmux command and a cursor probe as two. `lib/tmux.js`
runs four and three. Every figure that depended on that model is replaced below; "What the first
measurement got wrong" lists them. The tables now describe the monitor with the scheduling change
of #2086 in place, and "Before and after" compares it with `main` at `4b0d8b2e`.

## What was measured, and how

- **The monitor is real; the fleet is synthetic.** `test/helpers/medusa-wake-matrix.js` drives
  `lib/medusa-wake.js`'s own tick through its seams, with session records in these states: no
  mail, idle with mail, busy, a draft in the composer, an unprofiled engine, a listener that is
  off, and a session that ended between the roster read and its scan. No live session was used.
- **Time is virtual.** Each seam call advances one clock by a stated cost, and ticks fire the way
  Node fires an interval: the next is due one interval after the previous one *started*. The
  output is the same on every machine.
- **One cost is measured, the rest are derived or estimated.** One `tmux` command took 18.5 ms at
  the median and 42 to 63 ms at the 95th percentile, timed against a throwaway tmux server on the
  development host. A pane capture is four commands (a liveness probe, an alternate-screen check
  that probes again and asks, and the capture) and a cursor probe is three, so a session holding
  mail costs seven: about 130 ms at the median. In-process lookups are modelled at under a
  millisecond each. Measured separately with zero-cost seams, the tick's own JavaScript took
  about 0.2 ms for 30 sessions.
- **Mail is waiting at time 0** and the eligible recipient's pane is at rest throughout.

What the numbers cannot say: the real cost of the store and of a native engine observer, and
anything about the live server. The instrumentation that would answer those
(`medusaWake.tickMetrics()`, `medusaWatchdog.tickMetrics()`) is in the code and is not yet exposed
on any route.

## The matrix

"First assessed" is when the monitor first read the eligible recipient's pane. "Woken" is when the
nudge was typed. "Latest start" is how late the worst tick began.

#### Mixed fleet, eligible recipient scanned last

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| mixed | 1 | 381 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| mixed | 2 | 381 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| mixed | 5 | 642 ms | 0 ms | 0 | 5.3 s | 10.4 s | 0 |
| mixed | 10 | 904 ms | 0 ms | 0 | 5.6 s | 10.4 s | 0 |
| mixed | 20 | 1168 ms | 0 ms | 0 | 5.9 s | 10.4 s | 0 |
| mixed | 30 | 1691 ms | 0 ms | 0 | 6.4 s | 10.4 s | 0 |

#### Mixed fleet, eligible recipient scanned first

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| mixed | 1 | 381 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| mixed | 2 | 381 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| mixed | 5 | 642 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| mixed | 10 | 904 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| mixed | 20 | 1168 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| mixed | 30 | 1691 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |

#### Every other session holds mail in a busy or drafting pane

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| median tmux cost | 1 | 381 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| 95th-percentile tmux cost | 1 | 629 ms | 0 ms | 0 | 5.3 s | 10.6 s | 0 |
| median tmux cost | 2 | 511 ms | 0 ms | 0 | 5.2 s | 10.4 s | 0 |
| 95th-percentile tmux cost | 2 | 1008 ms | 0 ms | 0 | 5.6 s | 10.6 s | 0 |
| median tmux cost | 5 | 902 ms | 0 ms | 0 | 5.6 s | 10.4 s | 0 |
| 95th-percentile tmux cost | 5 | 2145 ms | 0 ms | 0 | 6.8 s | 10.6 s | 0 |
| median tmux cost | 10 | 1554 ms | 0 ms | 0 | 6.3 s | 10.4 s | 0 |
| 95th-percentile tmux cost | 10 | 4039 ms | 0 ms | 0 | 8.7 s | 10.6 s | 0 |
| median tmux cost | 20 | 2858 ms | 0 ms | 0 | 7.6 s | 10.4 s | 0 |
| 95th-percentile tmux cost | 20 | 4427 ms | 0 ms | 0 | 13.3 s | 15.6 s | 0 |
| median tmux cost | 30 | 4162 ms | 0 ms | 0 | 8.9 s | 10.4 s | 0 |
| 95th-percentile tmux cost | 30 | 4438 ms | 0 ms | 0 | 17.9 s | 20.6 s | 0 |

#### A pane read that times out (5 s) is scanned first

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| one hung pane | 2 | 5002 ms | 2 ms | 1 | 10.1 s | 15.4 s | 0 |
| one hung pane | 5 | 5005 ms | 5 ms | 1 | 10.3 s | 15.4 s | 0 |
| one hung pane | 10 | 5008 ms | 8 ms | 1 | 10.5 s | 15.4 s | 0 |
| one hung pane | 20 | 5014 ms | 14 ms | 1 | 10.9 s | 15.4 s | 0 |
| one hung pane | 30 | 5022 ms | 22 ms | 1 | 11.4 s | 15.4 s | 0 |
| two hung panes | 30 | 5399 ms | 22 ms | 3 | 16.4 s | 20.4 s | 0 |
| three hung panes | 30 | 6315 ms | 1315 ms | 5 | 21.3 s | 26.8 s | 0 |
| ten hung panes | 30 | 5930 ms | 930 ms | 12 | 56.1 s | 61.5 s | 0 |

#### A scan that throws is scanned first

| Run | Sessions | Longest tick | Latest start | Overruns | First assessed | Woken | Duplicates |
|---|---|---|---|---|---|---|---|
| one throwing scan | 2 | 381 ms | 0 ms | 0 | 5.1 s | 10.4 s | 0 |
| one throwing scan | 5 | 643 ms | 0 ms | 0 | 5.3 s | 10.4 s | 0 |
| one throwing scan | 10 | 774 ms | 0 ms | 0 | 5.5 s | 10.4 s | 0 |
| one throwing scan | 20 | 1168 ms | 0 ms | 0 | 5.9 s | 10.4 s | 0 |
| one throwing scan | 30 | 1691 ms | 0 ms | 0 | 6.4 s | 10.4 s | 0 |

#### Restart and departure

| Run | Result |
|---|---|
| Restart after the nudge, durable attempt record readable | 0 duplicate nudges |
| Restart after the nudge, durable attempt record unreadable | 1 duplicate nudge(s) |
| Busy recipient leaves the roster with mail deferred | nudged 0 times; its last ledger row stays `skipped pane-turn-in-flight` and nothing supersedes it |
| Same, and a replacement session of the project joins | replacement nudged 1 time; the departed session's `skipped` row remains |

## What the numbers show

1. **Fleet size alone does not starve a recipient.** A quiet session costs well under a
   millisecond. With a mixed fleet of 30, a tick takes 1.7 s and the wake is the same 10.4 s as
   with one session.
2. **The floor is two ticks.** A recipient at rest is woken about 10.4 s after its mail arrives:
   up to one interval before the first look, then the two-tick idle debounce. Nothing triggers a
   look when the mail arrives or when a pane comes to rest.
3. **What costs time is sessions that hold mail, because each is seven tmux commands.** With mail
   in every pane, 30 sessions make a 4.2 s tick at median tmux cost. At the 95th percentile the
   reads no longer fit in one tick.
4. **The tick is synchronous, so its duration is a stall of the whole server.** `lib/tmux.js`
   uses `execSync`. For as long as a tick runs, no HTTP request, WebSocket frame or other timer
   is served. The real-timer run (`--real`) shows the longest event-loop stall equal to the
   longest tick in every case. The scheduling change bounds that stall. It does not remove it.
5. **A hung pane is still discovered by paying its timeout.** tmux calls time out at 5 s, which is
   the tick interval. The monitor reads at most one such pane per tick and then leaves it alone
   for a growing interval, so the recipients behind it lose one tick per hung pane, not one
   timeout per hung pane per tick.
6. **A scan that throws costs nothing.** The tick catches it and moves on.
7. **No run produced a duplicate nudge or typed into a pane that was not at rest.**
8. **A restart does not repeat a nudge while the durable attempt record is readable.** The
   in-memory watermark is lost, and `alreadyAttempted` restores it. If that read throws, the
   monitor falls back to memory, which is empty after a restart, and nudges a second time.

## Before and after the scheduling change

30 sessions. "Before" is `main` at `4b0d8b2e`. "After" adds three rules, each of which only
defers: a tick stops reading panes at a 4 s budget or after one slow read; a pane whose read was
slow is backed off for 10, then 30, then 60 s; and sessions are scanned in the order resting,
then longest-deferred, then the rest.

| Run | Longest tick, before | after | Recipient woken, before | after |
|---|---|---|---|---|
| Mixed fleet, recipient scanned last | 1.7 s | 1.7 s | 11.7 s | 10.4 s |
| Mail in every pane, median tmux cost | 4.2 s | 4.2 s | 14.2 s | 10.4 s |
| Mail in every pane, 95th-percentile tmux cost | 11.6 s, 2 overruns | 4.4 s, none | 28.0 s | 20.6 s |
| One hung pane scanned first | 6.7 s | 5.0 s | 18.1 s | 15.4 s |
| Two hung panes | 11.7 s | 5.4 s | 28.1 s | 20.4 s |
| Three hung panes | 16.6 s | 6.3 s | 37.9 s | 26.8 s |
| Ten hung panes | 51.2 s | 5.9 s | 107.1 s | 61.5 s |

What the change does not do: the first look at a recipient behind hung panes comes no sooner
(21.3 s behind three, before and after), and each tick that reads a hung pane still holds the
server for its 5 s. Both need pane reads that do not block, which is the next change for #2086.

A recipient's two at-rest observations are always on consecutive ticks. A tick that deferred a
session, or left it in backoff, did not look at its pane, so its idle streak ends there and a
nudge needs two fresh observations.

## What the first measurement got wrong

| Figure | First measurement | Now |
|---|---|---|
| tmux commands per session holding mail | 3 | 7 |
| Cost of such a session, median | about 56 ms | about 130 ms |
| Tick with mail in every pane, 30 sessions, median | 1.9 s | 4.2 s |
| The same at the 95th percentile | 4.7 s, no overrun | 11.6 s, 2 overruns (on `main`) |
| Mixed fleet tick, 30 sessions | 0.9 s | 1.7 s |
| Wake behind one, two, three hung panes (on `main`) | 16.5, 26.5, 36.4 s | 18.1, 28.1, 37.9 s |

The direction of every finding held. Finding 3 is stronger than first reported: a fleet of 30
with mail in every pane already overruns the interval at ordinary tmux latency.

## The hypotheses on #2086

| Hypothesis | Result |
|---|---|
| A large fleet pushes back the tick slot of the one session that has mail | **Refuted** for quiet sessions: they cost well under a millisecond each. |
| Per-session lookups before the mail check add up across a fleet | **Refuted** at 30 sessions, with the estimated lookup costs. Not measured against the real store. |
| Contention among sessions that do have mail can delay a wake | **Confirmed.** About 130 ms per such session at the median, all of it tmux. |
| A slow early-scanned session can starve a later one | **Confirmed as delay, not as starvation.** Bounded by the scheduling change; removed only by non-blocking reads. |
| The tick has no overrun or queue-lag handling | **Confirmed** on `main`. The budget now keeps a tick inside its interval unless it meets a hung pane. |
| Retry is interval polling, blind to state transitions | **Confirmed.** Finding 2. Unchanged. |
| An ended or listener-off session is reported as undelivered for ever | **Confirmed**, below. Unchanged. |

## What `/api/medusa/deliveries` returns today

Read from the code, and checked against one live read of the route on 2026-10-04.

- **A row is the newest ledger entry of a session whose last outcome was not `nudged`.** The
  ledger (`medusa_deliveries`) is written only while a session is being scanned with unread mail.
- **Nothing writes a row when a session ends.** A session that was last seen busy, wrapping or
  drafting keeps that `skipped` row. The synthetic run shows it: the departed session is never
  typed into, and its last row is never superseded.
- **A replacement session does not clear it.** Rows are keyed by session id. The project's next
  session gets its own row and its own nudge, and the departed session's row stays.
- **The route's own filter keeps such a row for ever.** `_stillHasUnhandledMail` returns true as
  soon as the session's listener is `off` or has no workspace, before it looks at the exchange
  record. An ended session has no listener.
- **The exchange record already knows better.** Session teardown ends that workspace's open
  exchanges as `recipient_retired` and tells their senders. The deliveries route does not consult
  it for a session without a listener.
- **The row carries no liveness, no age and no next action.** Its fields are the session, project
  and workspace ids, the message key, the unread count, the outcome, the skip reason and
  `createdAt`. `createdAt` is when the verdict last *changed*, which is neither when the mail
  arrived nor when the monitor last looked.

The live read returned 103 rows, dated from 2026-08-21 to that morning:

| Rows | What they are |
|---|---|
| 5 | Sessions in the live roster this session could see (16 sessions). All five were held by a busy pane or engine minutes earlier. |
| 98 | Sessions not in that roster. The roster was a partial view, so a few of these may be live. |

By skip reason, the 98 were: `wrap-running` 53, `pane-writing` 15, `pane-turn-in-flight` 11,
`engine-thread-busy` 7, `unprofiled-engine` 5, `pane-agents-running` 3, `engine-channel-absent` 2,
`wake-not-opted-in` 1, `engine-thread-unknown` 1. Over half are sessions whose last scan fell
inside their own wrap, which is the last thing a session does.

So today the route cannot tell current backlog from historical records. Classifying its rows needs
three facts it does not have: whether the session is still live, what the exchange record says
about its mail, and when the monitor last assessed it.

## Live observations on the day

Two cases seen on the live fleet on 2026-10-04 while this was being measured. Both are
observations with a hypothesis, not measurements.

- **A long turn holds inbound mail while outbound mail works.** A blocking message to a Builder
  aged at 5 minutes with the blocker `pane-writing`, which the monitor had reported continuously
  for 15 minutes. In that window the same Builder sent its sender a progress message. The inbox
  stayed queued.
- **Three dispatches sat unread while the recipient's pane was writing.** The session measuring
  this received them only when its turn ended, with `pane-writing` on its ledger row.

Each deferral was correct: the pane was not at rest, and nothing may be typed into it. The
hypothesis is about what is missing around the gate. Sending mail does not make a session read its
own inbox, so an agent in a long turn can talk and not listen. And because the monitor only polls,
a wake waits for the pane to be at rest on two consecutive ticks, which a session that works
without pause may not offer for a long time.

## Not measured

- The live server's tick durations. The meter is in place; reading it needs a route or a log line.
- The native engine observer's cost (`engine-thread-*` verdicts). The synthetic fleet uses
  pane-judged engines (Claude and Antigravity profiles).
- The delivery watchdog under load. Its pass is metered and tested, and no matrix was run over it.
- The duplicate case against the real `lib/medusa-exchanges.js`. The harness models the durable
  attempt record as a set.
- A single pane that hangs while the tmux server answers for the others. Every tmux timeout this
  repository has recorded was a wedged server, where every read hangs. The matrix models the
  single-pane case because #2086 asks for it.
