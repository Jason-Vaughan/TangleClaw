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

Each live lane carries three separate blocks, and a fourth when it was nudged or escalated:

| Block | What it is |
|---|---|
| `engine` | What the pane was observed doing: `busy`, `at-rest`, `not-at-rest` or `unknown`, with `reason`, `observedAt`, `ageSeconds` |
| `workload` | The newest receipt, with `provenance`: `explicit-receipt`, `stale` (with `staleReason`) or `none`. `narrowing` is present when the operator has narrowed the lane |
| `composed` | The verdict: `availability`, `clearance`, and the `reasons` behind it |
| `nudge` | `null`, or what was done about the lane's stale receipt and not answered: `nudgedAt`, `receiptSeq`, `ageSeconds` for the nudge (`nudgedAt` is `null` on a lane escalated without one, and `notNudgedReason` then says why), and `escalatedAt`, `escalatedAgeSeconds`, `escalationRoute` (`coordinator` or `operator`) and `escalatedTo` (the coordinator project's name, `null` on the operator route) for the escalation. See [Nudging a lane whose report expired](#nudging-a-lane-whose-report-expired) |

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

### When the nudge goes unanswered

A nudge that no fresh receipt answers within `workloadNudge.escalateAfterMinutes` (10 by default) is escalated, once per expired receipt: the server sends one switchboard message to the live session of the project named in the silent lane's own `workloadNudge.coordinatorProject`. The message names the lane, says how long it has been silent, whether and when it was nudged, and what its engine was last observed doing. It is a fixed template: nothing from a receipt's summary or the project's nudge text is in it. It needs no reply.

- **The coordinator is whoever the lane's config names.** No project is treated as a coordinator because of its name or its role.
- **A fresh receipt first means no escalation**, ever, for that expiry.
- **A lane that could not be nudged is escalated too**, with the reason, once the same number of minutes has passed since its report expired: a web UI session, an engine with no wake profile, a pane showing a startup dialog, a pane that could not be typed into, or an engine observed `busy`, `not-at-rest` or `unknown` at that moment. If its pane comes to rest first it is nudged instead, and the time then runs from the nudge. Once escalated without a nudge it is not nudged later for that report.
- **A lane left alone on purpose is not escalated.** One that is held or stopped, or running a wrap, is neither nudged nor escalated while that lasts.
- **A lane with nobody to tell is recorded on the operator route.** That is a lane that names no coordinator or names itself, one whose coordinator is not a project on this install or has no live session, and one whose message the Hub refused five times running. The reason the coordinator could not be reached is recorded as its own row. **Nothing is sent on the operator route in this version**: the row is the record that the operator is owed the news, and nothing delivers it yet.

`tc sessions` shows all of this on the lane's line, after the engine's reading, and the session's own `tc workload show` says the same on its "Coordinators see" line:

| The lane's line ends | Meaning |
|---|---|
| (no clause, on a stale lane) | silent and not noticed: not nudged, not escalated |
| `; nudged 14m ago, not yet answered` | silent and nudged |
| `; nudged 14m ago, escalated to TC-Lane-INT 4m ago` | silent, nudged, and its coordinator was told |
| `; not nudged (startup dialog), escalated to TC-Lane-INT 4m ago` | silent, could not be nudged, and its coordinator was told |
| `; nudged 14m ago, nobody to escalate to: recorded for the operator 4m ago, nothing sent` | silent, nudged, and nobody could be told |

The clause goes when the session writes a fresh receipt.

Every nudge and escalation is a row in `workload_nudge_facts` with its time: `nudged`, `not-nudged` (with the reason as its `code`), `escalated` (with its `route`, and the coordinator as `target_project_id`) and `escalation-undeliverable`. When the lane answered is not stored there: it is the next receipt of that launch in `workload_receipts`.

What the monitor never does: it clears, restarts and ends nothing, and it writes no receipt on a session's behalf. A lane it nudged or escalated stays `UNKNOWN` until the session itself reports.

**Limits:**

- A nudge is a typed prompt. A session that is wedged will not answer it.
- The pane's state is the observer's last reading, which can be up to 30 s old.
- The line is typed before the nudge is recorded, so that a nudge is never on record for a pane that refused it. If the record cannot be written, the server remembers the nudge, retries the write every tick and does not type again. A server restart while the write is still failing is the one case in which a session can get the line twice for one expiry.
- An escalation is a message to another session. A coordinator that is itself wedged will not act on it, and nothing checks that it did.
- Nothing is restarted or cleared, for the silent lane or for its coordinator. What to do about a silent lane is the coordinator's decision.
- A lane that never reported is not watched. The monitor acts only on a receipt that expired by age; a session that has written no receipt in its launch is neither nudged nor escalated.
- The operator route delivers nothing yet. A silent coordinator, and a lane with no reachable coordinator, are recorded and shown in `tc sessions`, and no notification leaves the server.
- The message is sent before the escalation is recorded, so that no escalation is on record for a message the Hub refused. A send that fails is tried again on the next tick, up to five times by one server process; the count starts again after a restart. If the Hub accepts the message and the record then cannot be written, the server remembers it, retries the write every tick and does not send again; a restart while the write is still failing is the one case in which a coordinator can get the message twice for one expiry.
- A session that reports while its escalation is already on its way to the Hub is still escalated for that expiry.
- Why a lane was not nudged is recorded only when it is escalated. Until then it is in the server log: the monitor logs each session's verdict, with its meaning, whenever it changes.
- The monitor logs which project and session it nudged or escalated, and to which coordinator. It never logs the nudge line, the escalation message or a receipt's summary.

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
