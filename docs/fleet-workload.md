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
  - No free-text field (`summary`, `--wait-detail`, task ids, `--branch`, the narrowing `reason`) may contain control characters (C0, DEL, C1), Unicode bidi controls (U+061C, U+200E/F, U+202A–202E, U+2066–2069) or U+2028/U+2029. Text in any script, right-to-left included, is fine.
- **Rate:** at most one receipt per second per lane (`429 WORKLOAD_RATE`).
- **Identity:** the server stamps the project, session, launch and control-assignment ids, the sequence and the time from your verified launch. A body carrying any of them, or any unknown field, is refused (`400 WORKLOAD_FIELD_NOT_WRITABLE`).
- **Who can write:** only your own pane, through `tc`, with a live launch (`403 WORKLOAD_BINDING_REQUIRED` otherwise).

## For coordinators: `tc sessions` / `GET /api/tc/sessions`

Each live lane carries three separate blocks:

| Block | What it is |
|---|---|
| `engine` | What the pane was observed doing: `busy`, `at-rest`, `not-at-rest` or `unknown`, with `reason`, `observedAt`, `ageSeconds` |
| `workload` | The newest receipt, with `provenance`: `explicit-receipt`, `stale` (with `staleReason`) or `none`. `narrowing` is present when the operator has narrowed the lane |
| `composed` | The verdict: `availability`, `clearance`, and the `reasons` behind it |

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
