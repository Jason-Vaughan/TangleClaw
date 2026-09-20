---
title: "#1635 — A silently primed session is never asked to start"
status: COMPLETE
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-20 (dispatch f46ebac8) — startup fast-follow, #1635 first
source: /Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/startup-fast-follow-handoff.md
governed_by:
  - .prawduct/artifacts/prime-delivery-direction.md   # ratified 2026-08-31, §3 amended 2026-09-17
  - .prawduct/artifacts/wrap-direction.md             # commitment 3 — gates advisory by default
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION
scope: startup-fast-follow
branch: fix/1635-startup-initial-turn
partition: serial — one seam in lib/sessions.js plus one new module; no parallel surface
Critic mode: cumulative-final
---

# #1635 — A silently primed session is never asked to start

## The confirmed root cause

**The silent-prime path delivers context but never starts a turn, and nothing
else does either until a ten-minute timeout fires.**

Established mechanically, not inferred:

1. `silentPrime` ships `true` (`lib/project-config.js:33`) and is ON for this
   project — `.tangleclaw/session-prime.md` exists and the hook is wired.
2. `lib/sessions.js` `_deferEngineInit` Phase 2 is guarded
   `if (primeText && !silentPrime && …)`. With silent prime on, **every** pane
   write at launch is skipped. Nothing is typed.
3. `data/hooks/sessionstart-prime-claude.sh` `cat`s the prime to stdout, which
   the engine injects as *hidden model context*. Context is not a turn: the
   agent boots fully briefed, at an empty prompt, with nothing to answer.
4. The only later writer is `lib/launch-unready.js`, and it is gated on
   `unreadyWindowMinutes`, default **10** (`lib/project-config.js:211`). Its own
   docstring is explicit that it is "not a gate" and "not a retry loop" — one
   nudge, and only after the window.

So a launch that is working exactly as designed still waits ten minutes for its
first step, unless a human types something first.

### The reproduction is already on the record, twice, with launch receipts

The issue asks for progress verified by receipts rather than by a successful
injection response. Two independent launches supply it:

| | session 1041 (Builder2, #1635 as filed) | session 1055 (this session) |
|---|---|---|
| created | 01:59:37 | 02:24:57 |
| steps served while untouched | 0 | 0 |
| what broke the wait | unready nudge 02:10:02 | a human prompt 02:26:27 |
| elapsed to that point | **10m 09s** — the window, to the second | 90s, cut short by the human |
| first step served | 02:10:06 (+4s) | 02:26:27 (+0s) |

Session 1055's snapshot at +84s
(`TangleClaw-Architect/.tangleclaw/reference/builder1055-before-assisted-start.json`)
records `rulesDelivery.channel: "rules-hook"`, `nudgeCount: 0`, `cursor: 0`,
`pagesServed: 0`. Nothing had failed. Nothing had been asked to happen.

**This is not the operator's hypothesis of a lost Enter, and not a transport
defect.** Injection demonstrably works — the nudge proves it on the same pane,
same engine. The seam is that on the silent path *no first turn is ever
submitted*, and #1621 is therefore a different defect until evidence says
otherwise.

### Why the governing Direction makes this a defect and not a choice

`prime-delivery-direction.md` §3, as amended 2026-09-17, permits serving rules by
**acknowledged pull** — the `tc start` sequence — instead of pasting them, and
that is now the default. The amendment's first bounding condition is that the
pull is *acknowledged, not merely available*.

A pull the agent is never prompted to begin cannot be acknowledged. The
amendment assumed a turn in which the agent would act; the silent-prime path
removed the only thing that created one. This fix restores that precondition —
it does not depart from the Direction, it is what makes §3 reachable.

## Confidence check

1. **Problem.** A session launched with silent prime serves zero launch steps
   until a human types, or until the 10-minute unready nudge fires.
2. **Success.** A freshly launched session begins its launch sequence within
   seconds, with no human prompt, and the launch receipts (`pagesServed`,
   `servedAt`) show it — while every confirmation gate the prime carries still
   holds, and no duplicate or unrelated turn is submitted.
3. **Out of scope.** #1621 (unless evidence proves the same seam), #1633's
   admission UX, #1176 re-delivery, rule-7 activation, any release or restart.

**Requirements Confidence: High.** The mechanism is read, not recalled; the
timing is corroborated by two independent launches.

## Design

A new `lib/launch-kickoff.js`, a one-shot sibling of `launch-unready.js`, sends
**one** TangleClaw-authored line into the pane at launch when — and only when —
the prime was delivered silently and the launch has a sequence to pull.

It reuses the gates that already exist rather than inventing transport:

- `medusaWake.ENGINE_WAKE_PROFILES[engineId]` — no probed pane signature, no
  typing. This is what keeps the fix **engine-agnostic by construction**: an
  engine without a profile degrades to today's behavior with a recorded reason,
  exactly as the unready monitor already does.
- `medusaWake.assessSessionIdle` — the single idle gate. A pane that is working,
  or that **holds unsent input**, is left alone. This is what satisfies the
  issue's "avoid submitting an unrelated draft".
- `sessions.injectCommand` — the same writer the nudge uses.
- `_awaitTypeable`, a local loop over `assessSessionIdle` — readiness-gated, so
  the send waits for an observed at-rest pane rather than a guessed delay.

### Decisions recorded

**[DECISION: a separate module rather than a second window inside
`launch-unready.js` | that module's contract is deliberately narrow — a monitor,
"not a gate", "not a retry loop", one nudge of budget — and overloading it with a
launch-time responsibility would make a single module answer two different
questions with one nudge counter | reviewer may fold them if the duplication
proves larger than the contract it protects]**

**[DECISION: wait on `assessSessionIdle` rather than `sessions._awaitPaneReady`
| the design first named `_awaitPaneReady`, and the code does not call it. That
gate answers "has this pane finished booting" — the question the prime paste
asks before typing a payload. The kickoff asks a different one: "is it safe to
submit a turn right now", which must also refuse a pane holding an unsent draft,
and only the idle gate reads `composer-has-input`. Using the readiness gate would
have satisfied the plan's wording and failed the issue's "do not submit an
unrelated draft" requirement | cost: a second waiting loop beside the one in
`launch-unready`, which is the duplication R-8 names; and `_awaitPaneReady`'s
90-second horizon had to be restated here rather than inherited | reviewer may
prefer the readiness gate plus an explicit draft check, which is the same two
questions asked separately]**

**[DECISION: record the kickoff via `activity.log` (`launch.kickoff`) and
in-process state, NOT a new column on the sequence row | a column is a schema
migration, and the next unshipped schema version is contended by Train 21 car
21.9; the durable answer to "did it work" already exists on the row as
`pagesServed`/`servedAt`, so a column would store a second copy of a fact we
already have | cost: a server restart between launch and kickoff loses the
one-shot, which the unready monitor still covers — degradation, not loss]**

**[DECISION: the kickoff line carries no rule text and writes NO
`session_rule_deliveries` row | the rules did not ride this channel; the hook
delivered them. Writing a rules row for a line that carries no rules is the
true-but-useless delivery accounting §4 exists to forbid, and the code comments
around `_recordRuleDelivery` name it as the one thing that ledger must catch]**

### What it must not do

- Never block or fail a launch (`wrap-direction.md` commitment 3; prime Direction
  "Nothing here may block or fail a session launch").
- Never press Enter blindly or repeatedly, and never send twice.
- Never authorize work: the line asks the session to read its launch context, and
  the prime's own confirmation gates are untouched.
- Never claim more than was observed: a send is a send, not proof the engine
  consumed the turn. The receipt that settles it is `pagesServed` moving.

## Chunks

### Chunk 01 — the kickoff, its gates, and its tests
- [x] `lib/launch-kickoff.js`: pure `kickoffLine()`, `_internal` seams mirroring
      `launch-unready.js`, one-shot per sequence.
- [x] Wire it from `_deferEngineInit`'s silent-prime branch, readiness-gated.
- [x] Tests: the silent path sends exactly one line; the pasted path sends none;
      a busy pane and a pane holding unsent input are both left alone; an engine
      with no wake profile degrades with a recorded reason; a second call is a
      no-op; no rules-delivery row is written.
- [x] Regression test pinning the reported defect: silent prime + a sequence ⇒
      something is sent (today: nothing).
- **Done when:** suite green, `/prawduct:critic`, artifacts updated.

### What the Critic changed (review `rev-20260920T042214Z-1c84e28d`)

0 blocking, 11 warnings, 3 notes. Fixed in one pass:

- **The line stated a cursor it never read** (R-3/R-6) — `kickoffLine` hardcoded
  `0 of N`, the one thing #1599 exists to forbid, in the module written beside
  the sibling whose comment says so. It now renders the count from a sequence
  re-read after the wait, and a launch whose cursor already moved returns
  `already-begun` instead of telling a reading session to begin reading.
- **The one-shot burned on a slow boot** (R-7) — `IDLE_TIMEOUT_MS` was picked,
  not derived, at 30s, and the claim was made before the wait. It is now 90s,
  tied to the same measured 41-second boot that sized `PANE_READY_TIMEOUT_MS`,
  and the claim is given back on every path that typed nothing.
- **Four outcomes were invisible** (R-11) — the wiring logged at `debug` while
  `lib/logger.js` defaults to `info`, so a recurrence could not be told from a
  branch that never ran. Now `info`, with the session id.
- **The branch second-guessed the module** (R-10) — it re-tested `silentPrime`,
  making `not-silent` and `no-pane` unreachable outside tests. It now tests only
  whether this is a real launch, as its own comment already claimed.
- **Coverage gaps** (R-4/R-5) — a real `launchSession` now proves the 9th
  positional kickoff context is built from the launch's own session, project and
  sequence; and the "no rules-delivery row" claim has the test the plan promised.
- **Docs** (R-9/R-2/R-12) — `docs/engine-guide.md` names the fourth `wake`
  consumer and what an unprofiled engine now degrades to; the `_awaitPaneReady`
  → `_awaitTypeable` substitution is recorded as a decision above rather than
  left as silent drift from this plan.

Accepted rather than fixed: **R-8**, the near-verbatim duplication with
`launch-unready.js`. It is real and the plan delegated the call, but extracting a
shared pane-writer means editing a shipped, load-bearing monitor inside a fix for
a different defect. Filed as #1669 so the third writer pays for the
extraction rather than this one.

## Status

- [x] Chunk 01
