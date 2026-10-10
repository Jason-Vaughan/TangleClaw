# Fleet workload

A lane reports what it is doing; coordinators read one composed verdict per lane. This is the
reference for #1912. The contract, including why each rule is what it is, is
[ADR 0020](adr/0020-session-workload-receipts.md).

## For a session: `tc workload set`

```
tc workload set <working|waiting-external|blocked|complete> --clearance <safe-to-clear|do-not-clear|unknown>
                --summary "<one line>" [--wait <ci|review|operator|peer|merge|other> [--wait-detail "<text>"]]
                [--issue <n>]... [--pr <n>]... [--task <id>]... [--branch <name>] [--head <sha>]
tc workload show
```

Report at:

- dispatch acceptance
- each task transition
- the start of any external wait
- completion
- before wrap
- before an intentional exit
- again before the receipt expires

`tc workload show` prints your newest receipt and the verdict coordinators see.

**Rules the server enforces:**

- **Values:**
  - `working` must be `do-not-clear`.
  - `waiting-external` needs `--wait`, and `--wait` belongs only to `waiting-external`.
  - `summary` is one line of 1–200 characters.
  - At most 10 each of issue, PR and task refs.
  - `--head` is a full 40-character SHA.
  - `--branch` is a valid git branch name.
  - Every free-text field (`summary`, `--wait-detail`, task ids, `--branch`, the narrowing `reason`) must be display-safe (ADR 0020 §3). It may contain no Unicode control (`Cc`), format (`Cf`), line/paragraph separator (`Zl`/`Zp`) or default-ignorable character, which covers bidi controls, zero-width characters, U+FEFF, U+00AD, tag characters and variation selectors, and it must contain at least one visible character. Any script, right-to-left included, is fine. Emoji that need a variation selector or a zero-width joiner are refused.
- **Rate:** at most one receipt per second per lane (`429 WORKLOAD_RATE`).
- **Identity:** the server stamps the project, session, launch and control-assignment ids, the sequence and the time from your verified launch. A body carrying any of them, or any unknown field, is refused (`400 WORKLOAD_FIELD_NOT_WRITABLE`).
- **Who can write:** only your own pane, through `tc`, with a live launch (`403 WORKLOAD_BINDING_REQUIRED` otherwise).

## For coordinators: `tc sessions` / `GET /api/tc/sessions`

Each live lane carries three separate blocks, and a fourth when it was nudged:

| Block | What it is |
|---|---|
| `engine` | What the pane was observed doing: `busy`, `at-rest`, `not-at-rest` or `unknown`, with `reason`, `observedAt`, `ageSeconds` |
| `workload` | The newest receipt, with `provenance`: `explicit-receipt`, `stale` (with `staleReason`) or `none`. `narrowing` is present when the operator has narrowed the lane |
| `composed` | The verdict: `availability`, `clearance`, and the `reasons` behind it |
| `nudge` | `null`, or the nudge the lane's stale receipt has had and not answered: `nudgedAt`, `receiptSeq`, `ageSeconds`. See [Nudging a lane whose report expired](#nudging-a-lane-whose-report-expired) |

**`availability`**, first match wins:

| Value | When |
|---|---|
| `UNKNOWN` | the session is not active, or it is a Project Master lane (`unsupported-master-lane`) |
| `STOPPED` / `HELD` | the project's open control assignment is stopped / held |
| `WORKING` | the engine is observed busy, whatever the receipt says |
| `UNKNOWN` | no current receipt |
| `WORKING` / `WAITING` / `BLOCKED` | the current receipt says `working` / `waiting-external` / `blocked` |
| `AVAILABLE` | the current receipt says `complete` + `safe-to-clear` **and** the engine is observed at rest |
| `COMPLETE_NOT_CLEAR` | `complete` in any other case |

**Treat `UNKNOWN` as "ask", never "assign".** A pane at rest alone never makes a lane available.

**A receipt stops counting when any of these happen:**

- It expires: 30 min for `working`; 120 min for `waiting-external`, `blocked` and `complete`.
- A control hold, release, stop, rebind or close is recorded after it.
- A wrap is requested, or starts after it.
- The launch ends.

Ordinary messages supersede nothing. A typed assignment-dispatch will, once it exists (ADR 0020 §4).

## Nudging a lane whose report expired

Off by default. A project turns it on in its own config, with [`workloadNudge`](configuration-reference.md) (`{"enabled": true}`); there is no settings screen for it.

With it on, a monitor in the server checks that project's live sessions every 30 s. A session whose newest receipt **expired by age** gets one line typed into its pane, asking it to report with `tc workload set`. The project's `workloadNudge.text` replaces that line whole.

- **Once per expired receipt.** The nudge is a row in `workload_nudge_facts`, so a second tick, a second server process and a server restart do not type it again. A session that reports and later lets that report expire too is nudged once for the new one.
- **Only into a pane observed at rest.** Nothing is typed while the engine is observed `busy`, `not-at-rest` or `unknown`, while a wrap is running in the session, into a held or stopped lane, or into a pane showing an engine startup dialog. Each of these is checked again on the next tick.
- **Only for an expired receipt.** A receipt that stopped counting because a wrap started, a control event was recorded or the launch ended is not nudged, and neither is a session that has written no receipt at all in its launch.
- **Not every session has a pane that can be typed into.** A web UI session, and a session on an engine with no wake profile, is never nudged.

`tc sessions` shows it on the lane's line, after the engine's reading: `; nudged 14m ago, not yet answered`. The session's own `tc workload show` says the same on its "Coordinators see" line. The clause goes when the session writes a fresh receipt. A stale lane without it was not nudged.

What the monitor never does: it clears, restarts and ends nothing, and it writes no receipt on a session's behalf. A lane it nudged stays `UNKNOWN` until the session itself reports.

**Limits:**

- A nudge is a typed prompt. A session that is wedged will not answer it.
- The pane's state is the observer's last reading, which can be up to 30 s old.
- The line is typed before the nudge is recorded, so that a nudge is never on record for a pane that refused it. If the record cannot be written, the server remembers the nudge, retries the write every tick and does not type again. A server restart while the write is still failing is the one case in which a session can get the line twice for one expiry.
- Nobody else is told yet when a nudge goes unanswered: `coordinatorProject` and `escalateAfterMinutes` are stored and not acted on in this version.
- Why a lane was not nudged is in the server log and nowhere else yet: the monitor logs each session's verdict, with its meaning, whenever it changes.
- The monitor logs which project and session it nudged. It never logs the nudge line or a receipt's summary.

## Engine observation

A background observer checks the pane of every live tmux session whose engine has a wake profile.

- **When:** every 10 s, whatever the session's mail state.
- **Budget:**
  - Captures are asynchronous and serial.
  - Each gets at most 1 s, and never more than what remains of the tick's 3 s budget.
  - A tick that runs out resumes where it stopped.
  - Measured on the pilot host: p95 29 ms per capture.
- **At rest:** no turn in flight, no running agents and an empty composer, seen on two stable consecutive observations. A dialog, a menu or a missing at-rest marker reads `not-at-rest`.
- **Staleness:** an observation older than 30 s reads `unknown`.

The fleet read only reads this cache; it never captures a pane.

## For the operator: narrowing a lane

`POST /api/tc/workload/narrowing` is operator only, with the same proof tiers as control:

```
{ "sessionId": 42, "forceUnknown": true, "reason": "reviewing this lane" }
{ "sessionId": 42, "capClearance": true, "reason": "do not clear until I say" }
{ "sessionId": 42, "clear": true, "reason": "done reviewing" }
```

What a narrowing can do:

- Cap clearance at `do-not-clear`.
- Turn `AVAILABLE`, `COMPLETE_NOT_CLEAR`, `WAITING` or `BLOCKED` into `UNKNOWN`.

What it cannot do:

- Hide `WORKING`, `HELD` or `STOPPED`.
- Raise anything.

`reasons` keeps the base verdict beside the narrowed one. A narrowing ends with the launch. No session, ProjectManager or Architect can narrow.

## What is never done

No code reads pane text or transcripts for workload or clearance. The visible "STATE", "SAFE TO CLEAR" and "DO NOT CLEAR" lines a session prints are for humans. A test fails if shipped code starts matching them.
