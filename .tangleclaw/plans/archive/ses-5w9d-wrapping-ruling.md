---
artifact: build-plan
version: 2
scope: ses-5w9d
depends_on:
  - artifact: data-model
  - artifact: architecture
  - artifact: api-contract
governed_by:
  - artifact: data-model
    dispositions:
      - "Governance state is derived from disk, never stored → the norm's *shape* is the ruling's whole argument, applied one table over. A session's wrap-in-progress state is derived from the process that is running the wrap; persisting it creates a second source of truth that can contradict the first, which is exactly what a `wrapping` row surviving a restart does."
      - "A project's configuration travels with the project → inapplicable. Session status is TangleClaw's own runtime record, not project configuration, and nothing here changes what lives in `<project>/.tangleclaw/`."
      - "The Project Master has no sessions or projects footprint → conforms and is untouched; `tangleclaw-master` has no session row to hold any status."
  - artifact: architecture
    dispositions:
      - "A read that could not be established reports null and names itself, never a plausible default → ENGAGED, and it is the constraint on the replacement. `getSessionStatus`'s wrapping branch is one of the most careful implementations of this norm in the codebase (#908's `incomplete`/`cause` vocabulary). Re-sourcing wrap state from the run registry must carry that vocabulary forward, not lose it: the registry can say 'no run', and 'no run' after a restart is an ESTABLISHED answer, which is precisely why it is the better source."
      - "A dependency's failure degrades TangleClaw, never crashes it → conforms; nothing here adds a dependency."
  - artifact: api-contract
    dispositions:
      - "The wrap POST's `status: \"wrapping\"` is a contract this ruling does NOT break — it is already sourced from the run registry, not the sessions table. The `GET /api/sessions/:project/status` responses documented at `api-contract.md` §769-840 ARE sourced from the dead DB state, and they are the contract this ruling changes. Recorded as two separate surfaces because conflating them is how a reader concludes the whole `wrapping` vocabulary is being retired."
last_validated: 2026-09-06
---

## The Ruling

**`wrapping` does not survive as a persisted session status. The concept survives, sourced from
`lib/wrap-run-registry.js`.**

Ruled by the operator 2026-09-06, on the evidence below. #1034 warned that the likeliest way to
get this wrong is to phrase it as "remove the unreachable pathway" and thereby authorise the
smaller branch by accident. It was not phrased that way: both branches were priced, and the
argument that decided it is a positive one about where the truth lives, not an appeal to the code
being dead.

## Requirements Confidence

**Level:** High

**Why:** The ruling rests on evidence gathered from the live database, the git history and the
code, and two of #1034's own load-bearing claims did not survive that check. Both corrections are
recorded here because the issue will outlive this plan and its text is what a later reader finds.

**Correction 1 — the state was live, and was used 166 times.** #1034 states: "The operator's live
database holds **zero `wrapping` rows across 875 sessions** back to 2026-03-14 … Not 'none right
now': none in the table's entire history." That inference does not follow from its evidence.
`sessions.status` is a single column that `store.sessions.wrap` **overwrites** on transition, so a
completed wrap leaves no trace of ever having been `wrapping`. A snapshot of that column can only
ever say what is true now. The history is in `activity_log`, and it says:

| | |
|---|---|
| `session.wrapping` rows | **166**, from 2026-03-18 to **2026-05-21** |
| by month | 2026-03: 70 · 2026-04: 69 · 2026-05: 27 · nothing after |
| `session.wrapped` by month | 03: 70 · 04: 62 · 05: 31 · 06: 18 · 07: 128 · 08: 73 · 09: 14 |

`setWrapping` writes that row only when its `UPDATE … WHERE id = ? AND status = 'active'` changed
something, so each of the 166 is a real transition. The read side had rows to serve; they were
transient by design and every one of them moved on.

**Correction 2 — it died in May, not July, and the cause named in the issue is the wrong commit.**
The July note attributes the loss to Chunk 05 of prawduct-v2-sunset (`9c67b2c`, 2026-07-18)
stripping the legacy NL-prompt wrap, "the LAST production caller of `store.sessions.setWrapping`".
The transitions had already stopped eight weeks earlier. `bdbb343` (2026-05-19) introduced
`_completeV2Wrap`, which calls `store.sessions.wrap(active.id, summary)` directly on the **active**
session — `active` → `wrapped` in one step, with no intermediate — and the last `session.wrapping`
row is dated two days later. The July strip removed a caller that was already dormant. This matters
beyond bookkeeping: it means the state was not lost by accident during a cleanup, it was designed
out by the V2 pipeline, which is a different fact about intent.

**Correction 3 — the vocabulary is five values, not seven.** #1034 lists the status literals as
`'active'`/`'wrapping'`/`'wrapped'`/`'killed'`/`'crashed'`/`'degraded'`/`'ended'`. Grepping every
`status = '...'` write across `lib/` and `server.js` returns exactly five: `active`, `wrapping`,
`wrapped`, `killed`, `crashed` — matching the live table, which holds only four of them (nothing
is `wrapping`). `degraded` and `ended` are real strings in this codebase but belong to other
domains entirely: `lib/model-status.js` maps provider-incident severities to `degraded`,
`server.js`'s health check computes a `degraded` service status, and `ended` is one of
`ai-content.js`'s `GATEWAY_TERMINAL_STATES`. None is a session status. An enum built from the
issue's list would have modelled two states the product does not have — which is worse than
modelling none, because a transition map that admits an unreachable state licenses code to handle
it.

**What follows from the corrections.** Since 2026-05-21, **233+ wraps have completed** with the
session sitting `active` for the duration. A V2 wrap takes minutes. So "nothing in the database
distinguishes an agent working from an agent wrapping" is not a hypothetical the ruling might
introduce — it has been the shipped behavior for three and a half months, and it is the real gap
this work should close.

**Open assumptions / unknowns:**

- [ASSUMPTION: the dashboard's wrap indicator can read the run registry from the process that
  serves the request | MED impact | verified at Chunk 02, and it changes that chunk's shape if
  false]. `lib/projects.js#enrichProject` moved most of its filesystem reads into the killable
  scanner child (#884); the registry is process-local module state in the server, so the branch
  that would consume it must run in the parent. If it turns out to run in the child, the
  registry's state has to reach it as an argument rather than as a require.

  **VERIFIED TRUE at the start of Chunk 02 — the branch runs in the PARENT, and the registry is
  readable by `require`. No argument-passing plumbing is needed.** Three independent proofs, any
  one sufficient:

  1. The branch reads SQLite. `lib/projects.js:873` calls `store.sessions.getActive`, a
     `better-sqlite3` prepared statement — and `lib/dir-scanner-child.js:26-38` refuses to open
     SQLite by design, in comments naming that refusal ("a process built to be killed"). There is
     no sessions handler in the child's `HANDLERS` table either.
  2. The branch already reads process-local module state of the server: `_liveSession` calls
     `engineErrors.get(row.id)` against a plain in-process `Map`. Were it running in the child,
     `lastEngineError` would already be permanently null and the #261 badge dead.
  3. Only `facts` crosses the boundary — six JSON fields from the child's `projectFacts` handler.
     `session` is not among them and never crosses.

  **What this changes about the chunk's shape:** nothing structural, but two design constraints
  follow from HOW the read should be made rather than whether it can be.

  - **Lazy require behind a seam, not a module-top require.** `lib/sessions.js` already requires
    the registry eagerly, and `projects -> sessions -> project-version -> projects` is a recorded
    cycle that has already cost this repo a partial-exports casualty. `lib/medusa-wake.js:1201`
    is the precedent to copy: the require lives inside an `_internal` seam object, which both
    avoids the edge and gives the tests a stub point.
  - **The fail posture INVERTS the precedent, and that is deliberate.** `medusa-wake` fails
    CLOSED (an unreadable registry means "assume a wrap is running") because withholding a
    keystroke is the safe error. A display indicator must fail OPEN: a registry read that throws
    must not paint "wrapping" onto every card on the dashboard. Same mechanism, opposite default,
    because the cost of being wrong points the other way.

**What would raise confidence:** N/A at High.

## Why the registry, and not the row

The two candidates are not "a live mechanism and a dead one". They are two places to keep the same
fact, and one of them cannot keep it truthfully.

`lib/wrap-run-registry.js` was built for #583 after the 2026-07-16 incident proved a client-side
single-flight guard cannot span tabs, devices or reloads. Its header states its own storage
decision:

> Process-local BY DESIGN: a pipeline cannot survive a server restart, so an empty registry after
> boot is the truth — a post-restart `begin` legitimately starts fresh. No persistence wanted.

That sentence decides this ruling. The only thing a persisted `wrapping` row offers over the
registry is **durability across a restart** — and the thing it would durably record is that a wrap
is in progress, which after a restart is **false**, because the pipeline died with the process. A
`wrapping` row that survives a reboot is not resilience; it is a lie with a one-hour shelf life.

And the machinery that cleans up that lie is substantial: `STALE_WRAPPING_THRESHOLD_MS`, the age
branch, the probe branch, `autoCompleteWrap`, `_wrapPaneCache` population on the wrapping path —
built across #105, #908 and #910, and **none of it has ever executed in production**, because
nothing has entered the state since May. Restoring the transition (the alternative branch) would
put all of it into production for the first time, against a path with no field history, in exchange
for a durability whose content is false by construction.

The registry, meanwhile, already answers the question, already survives the case that matters (it
says "no run", which after a restart is correct and *established* rather than unknown), and is
already the source the API reports from: `server.js#_wrapResultPayload` returns
`status: 'wrapping'` to every client today with no database row behind it.

**The honest cost of this ruling, stated rather than buried:** wrap state becomes
non-queryable and non-historical. Nothing will be able to ask "was this session wrapping at 04:12
yesterday", and a second server process (there is none today) would not see the first's runs. If
either becomes a requirement, the answer is to persist the *registry*, not to resurrect a status
column — the registry knows which run, which step, and what happened, where the column knew only
that something was happening.

## Status

- [x] Chunk 01: The status vocabulary is explicit, and `wrapping` is not in it (#1034)
- [x] Chunk 02: The dashboard says a session is wrapping again, sourced from the run registry (#1034)
- [x] Chunk 03: The vestigial `V2` designators are retired (#1034)

Context: Ruling made 2026-09-06 by the operator, as a gate between Train 13 and Train 14 — the
sequencing #1034's own comment sets, and the sequencing the roadmap coordinator halted Train 14 to
enforce. Train 14 is paused after its Chunk 01 and resumes when this closes.

Chunk 01 built 2026-09-06 on `feat/1034-session-status-vocabulary`. Reviewed twice: a cumulative
pass (0 blocking, 9 warnings, 6 notes — all dispositioned) and a `verify-resolutions` pass that
re-derived every warning from the tree and closed all nine.

**Live verification, on the restarted server** (listener pid 58339, cwd this repo, booted
15:10:58 — after `lib/store.js` at 14:39 and `lib/sessions.js` at 14:51, so it is running this
branch's code, measured rather than assumed):

| Surface | Result |
|---|---|
| `GET /api/sessions/TangleClaw/status` | `active: true`, no `wrapping` / `wrapFinished` keys, `incomplete: []`, `cause: null` |
| `GET /api/activity?type=session.wrapping` | **166 rows**, 2026-03-18 → 2026-05-21 — the retired emitter's history is still readable, which was the Verification Strategy's first check |
| `GET /api/tc/sessions` | 11 live sessions, all `active` — the collapsed `listLiveAll` |
| `GET /api/projects` | 57 projects, 10 session cards, all `status: active` — `enrichProject` with the wrapping branch removed. ScrapeGoat is in the roster but has no card: a live row whose pane tmux confirms is gone, correctly dropped rather than reported as a phantom |

**The Verification Strategy's second check PASSED: a real wrap, end to end.** The operator ruled
2026-09-06 that it rides the previous session's own wrap — this clone is the live install, so
wrapping a session here exercises the edited path while the branch is still unmerged. Session
**930** (TangleClaw, started 2026-09-06 04:53:27) wrapped at 2026-09-06 22:42:36Z on this
branch's code. All three criteria met, measured rather than assumed:

| Criterion | Evidence |
|---|---|
| Row ends `wrapped`, not `killed`/`crashed` | `sessions` row 930: `status=wrapped`, `ended_at=2026-09-06 22:42:36` |
| Non-null `wrap_summary` | 491 characters |
| `lifecycleCompleted: true` in the pipeline log | `[sessions] Wrap pipeline ran project=TangleClaw session=930 ok=true blockedAt=null stepCount=15 commitSha=16bfef9 lifecycleCompleted=true` |
| No `Refused a session status transition` warning | zero occurrences in `~/.tangleclaw/logs/tangleclaw.log`; the string is live at `lib/store.js:2607`, so the absence is a measurement and not a missing emitter |

The two suspects the check was aimed at — `_completeV2Wrap`'s derived `lifecycleCompleted` and
`store.sessions.wrap`'s new precondition — both behaved. Chunk 01's verification is complete and
the merge is unblocked.

No PR is open; none was asked for.

Chunk order is deliberate and the first chunk is NOT the deletion. Chunk 01 lands the enum and the
transition map — the thing #1034 actually asks for — with `wrapping` absent from it, which makes
the deletion a consequence of a modelled decision rather than a cleanup that happens to remove a
state. Chunk 02 then closes the gap the ruling exposes, because a ruling that only deletes leaves
the product worse at the thing the state was for.

### Chunk 01: The status vocabulary is explicit, and `wrapping` is not in it

- **Description:** Session status lives as scattered SQL string literals across `lib/store.js`'s
  `sessionsApi` and `lib/sessions.js` with no enum and no allowed-transition map — the modelling
  #1034 asks for. Introduce `SESSION_STATUS` and the transition table, mirroring the existing
  `SESSION_RULE_KINDS` pattern, over the four statuses that remain after the ruling — `active`,
  `wrapped`, `killed`, `crashed` — and no others (see Correction 3: `degraded` and `ended` are not
  session statuses). Retire the pathway that produced
  it and the recovery machinery built to clean up after it.
- **Closes:** part of #1034
- **Depends on:** none.
- **Artifacts consumed:** `data-model.md`, `architecture.md`, `api-contract.md`
- **Deliverables:** the enum plus the allowed-transition map, and the removal of the `wrapping`
  ecosystem. The consumers, enumerated from the code rather than inherited from the issue:

  | Site | What happens |
  |---|---|
  | `store.sessions.setWrapping` | deleted — no production caller since 2026-05-19 |
  | `store.sessions.getWrapping` | deleted, with its five call sites |
  | `lib/sessions.js` launch-time stale-wrapping recovery | deleted with `STALE_WRAPPING_THRESHOLD_MS` and `_parseSqliteUtcMs`'s use there |
  | `autoCompleteWrap` | deleted — its only caller is that recovery |
  | `getSessionStatus`'s wrapping branch + `_wrappingStatus` | deleted; the `active` branch already covers a wrapping session, since that is the status it now holds |
  | `completeWrap`'s `getWrapping() \|\| getActive()` | collapses to `getActive()` — the arm that runs today |
  | `session-ownership.js` `status === 'active' \|\| 'wrapping'` | collapses to `active` |
  | `store.sessions.getActiveAll`'s `IN ('active','wrapping')` | collapses to `active` |
  | `lib/projects.js`'s dashboard wrapping branch | **not deleted — re-sourced in Chunk 02** |
  | `_wrapPaneCache` | **kept.** It is populated on the wrapping path but read by `completeWrap` and the active path too; only the wrapping-branch population goes. |
  | `session.wrapping` activity event | kept as a type nothing emits any more, since the 166 historical rows must stay readable |
  | `api-contract.md` §769-840 | the `GET /status` wrapping responses are retired |
  | `api-contract.md` §1005 | **unchanged** — the wrap POST's `status: 'wrapping'` comes from the run registry, not the table |

  **Four behaviors the bundle ships that this table did not list.** Recorded here because
  Chunk 02 is planned against the registry read and Chunk 03 against `_completeV2Wrap`, and a
  reader who finds four hand-written corrections below reasonably treats the table as complete.
  All four are in `CHANGELOG.md`, so the release narrative was never wrong — the gap was
  traceability in the artifact the later chunks are designed from.

  | Site | What happens |
  |---|---|
  | `lib/medusa-wake.js` wrap gate | **new.** Reads `lib/wrap-run-registry.js` via the `_internal.wrapRunning` seam, so a wake cannot land mid-wrap. This makes Chunk 01 the registry's FIRST consumer, ahead of the plan's assignment of the registry to Chunk 02. Caveat as built: the Project Master gets no gate. |
  | `POST /wrap/complete` | answers **409 `SESSION_CHANGED`** for a finalize whose row ended mid-flight, where it answered 200; and no longer tears down the listener or commits the repo for a wrap that wrote nothing |
  | `DELETE /api/sessions/:project` | reports the row's real ending (`wrapped`) instead of borrowing `reconciled: true`, whose meaning is "there was no session row at all" — a branch that replies without a `sessionId` |
  | `_completeV2Wrap` | returns a boolean, surfaced on `triggerWrap`'s result as `lifecycleCompleted` **derived from** the write rather than asserted beside it. Deliberately NOT forwarded to the HTTP payload — see decision 4. |

  **Four decisions the plan did not settle, taken at build time.**

  1. **The transition map is ENFORCED, not merely declared.** It generates a SQL precondition on
     `wrap`/`kill`/`markCrashed`, so a transition the map does not allow changes no row. This is
     `setWrapping`'s own idiom (`AND status = 'active'`, return null on zero changes) generalised
     rather than a new invention, and an unenforced map would be a description that decays —
     `data-model.md` would say what the code no longer does. It also fixes a real defect: a
     second `kill` on an ended session currently rewrites `ended_at`/`duration_seconds` and
     appends a duplicate `session.killed` row to `activity_log`, corrupting exactly the history
     this ruling depends on being able to read.
  2. **A refused transition is a logged no-op returning the row unchanged — not a throw.** Roughly
     sixty call sites (fixtures, plus `server.js`'s kill route) call these unconditionally as
     "end it if it is still live"; throwing would turn a benign redundancy into a failure with no
     product benefit. The caller reads `.status` to learn what happened, and `log.warn` means the
     refusal is never silent. `_completeV2Wrap`'s comment that an already-wrapped row is
     "harmlessly re-stamped" describes the behavior being replaced and moves with it.
  3. **No `CHECK (status IN …)` constraint is added.** SQLite cannot add one without rebuilding
     the table, and the live install holds 875 session rows. The enum already constrains the only
     writer; the constraint would buy defence against a hand-written `UPDATE`, at the cost of a
     rebuild migration on the operator's live database.
  4. **`wrap_started_at` stays, as a historical column.** After `setWrapping` goes nothing writes
     it, but 166 rows carry a real value and dropping a column is the same table rebuild as (3).
     Documented in `data-model.md` as written by no current code path.

  **Deferred, and filed rather than dropped (issue #1302 — filed 2026-09-06; a Critic pass read a
  backlog cache snapshotted before it and reported it unresolved):** `public/session.js`'s status-poll branches on
  `data.wrapping` / `data.wrapFinished` / `data.wrapCompleted` become unreachable when this route
  stops sending those fields. They are not removed here — they hang off the wrap-idle modal
  (#98's history) and `finalizeFinishedWrap`, an operator-visible frontend surface that deserves
  its own chunk rather than a rider on a store deletion. The session page's own wrapping UI is
  already driven by the wrap POST and its stream, so nothing regresses in the meantime.
  `test/session-wrap-finalize.test.js` guards those same branches and is deferred with them —
  retiring the test first would leave shipped code unguarded, so it carries a note saying what it
  is waiting on.

  **One name in the table above is wrong:** the fleet-wide reader is `store.sessions.listLiveAll`,
  not `getActiveAll`. Same site, same collapse.

  **The `_wrapPaneCache` row above is wrong, and it was checked rather than trusted.** The table
  says it is "populated on the wrapping path but read by `completeWrap` and the active path too".
  There is no active-path read, and the wrapping branch held its ONLY `.set()` — verified against
  `HEAD` before deciding. After the deletion the Map has no writer, so `completeWrap`'s
  summary-recovery fallback could only ever return nothing, and `sessions.parseWrapSummary` behind
  it would have no caller but its own unit test. Both are deleted rather than kept, because a read
  of an always-empty cache reads to a later maintainer as a live contract. Nothing changes in
  production: the cache has been empty since 2026-05-21 for the same reason the status has.
  `_deriveV2WrapSummary` — which reads the pipeline's structured output rather than pane text — is
  the live summary producer and is untouched.

  **The `lib/projects.js` row above is wrong too.** It says the dashboard wrapping branch is
  "not deleted — re-sourced in Chunk 02", and it is deleted here. It had to be: the branch's only
  entry point was `store.sessions.getWrapping`, which the row two above deletes, so the two rows
  contradicted each other and only one could be acted on. The re-sourcing is still Chunk 02's, and
  `lib/projects.js` carries a comment at the site saying so — but see the Chunk 02 note below,
  because the branch was never rendering anything in the first place.

  **One defect found, not inherited.** `store.sessions.getActive` ordered by `started_at DESC`
  with no tiebreak. The column is second-resolution, so two rows created in the same second tie
  and SQLite settled it — in favour of the older row. That lookup decides which session a wrap or
  a kill lands on, and this chunk makes it the lookup for a mid-wrap session too. Fixed by
  breaking the tie on `id DESC` (also in `getLatest`), with a guard.

  **The one thing that must not be conflated.** The wrap POST already reports
  `status: 'wrapping'` with no DB row behind it. Retiring the persisted state does not retire that
  contract, and a chunk that treats "remove `wrapping`" as a vocabulary-wide sweep would break a
  live API response for no reason.
- **Tests:** the transition map rejects a transition that is not in it, and the suite's existing
  `setWrapping` fixtures (six files) are rewritten to the states that actually occur rather than
  deleted wholesale — a test that constructs an impossible state was testing the machinery, and its
  real subject (a wrap completing, a launch finding a live session) still exists. The mutation that
  must go red: re-add `wrapping` to the enum and the map's exhaustiveness assertion fails.
- **Acceptance criteria:** no code path can write `wrapping`; `SESSION_STATUS` and its transition
  map are the single source for the vocabulary; the 166 historical `session.wrapping` activity
  rows remain readable; the wrap POST's response shape is byte-identical.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. `/prawduct:critic` run and blocking findings resolved
  3. `data-model.md` and `api-contract.md` updated in the same commit
  4. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 02: The dashboard says a session is wrapping again, sourced from the run registry

- **Description:** The gap the ruling exposes and the reason it is not a pure deletion: for three
  and a half months a wrap taking minutes has shown as an ordinary active session. `lib/projects.js`
  has a branch that renders a wrapping card (`_liveSession(wrappingSession, 'wrapping')`) which has
  been unreachable since May. Point it at `wrapRunRegistry` instead of `store.sessions.getWrapping`,
  so the card returns — this time reading the mechanism that actually knows.
- **Closes:** part of #1034 — the operator-facing half
- **Depends on:** Chunk 01.
- **Artifacts consumed:** `architecture.md` (Direction: a read that could not be established
  reports null and names itself)
- **Deliverables:** the dashboard's wrap indicator sourced from `wrapRunRegistry.anyRunning` /
  `get`, carrying the registry's richer answer (which step, how long) as far as the card usefully
  can. The `incomplete`/`cause` vocabulary #908 established is preserved: the registry's "no run"
  is an **established** answer and must be reported as one, never as an unknown.

  **Verify the process boundary before designing the read** — see the open assumption above. If
  `enrichProject`'s relevant branch runs in the killable scanner child, the registry cannot be
  required there and its state has to be passed in.

  **The card this chunk means to restore does not exist in the frontend, found while building
  Chunk 01.** `_liveSession(row, 'wrapping')` set a `status` field on the card payload, and
  nothing renders it: `public/ui.js` reads `session.active`, `session.sessionMode`,
  `session.lastEngineError` and the unknown-read state, and never `session.status` (grep it — the
  only `.status` hits in `public/` are on session RULES). So even before the row stopped existing,
  a wrapping project's card looked identical to a running one. Pointing the server branch at
  `wrapRunRegistry` therefore changes nothing an operator can see; this chunk needs a frontend
  half — a field the card actually reads, and a dot or pill that reads it. That is also why its
  acceptance criterion is "verified by running a real wrap" rather than by tests: a test on the
  payload would have passed against a card that renders nothing.
- **Tests:** a project with a running wrap renders as wrapping; one with no run renders active and
  reports the answer as established rather than unknown; a finished run does not leave the card
  stuck.
- **Acceptance criteria:** starting a wrap changes what the dashboard says within one poll, and
  finishing it changes it back — verified by running a real wrap, not only by tests.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. Verified against a real wrap on this install
  3. `/prawduct:critic` run and blocking findings resolved
  4. Committed, PR merged, chunk marked `[x]` in Status

**Chunk 02 built 2026-09-06. The assumption held, and three decisions the plan left open were
taken at build time.**

1. **`tcSessionWrapping` is NOT a fourth value of `tcSessionLiveness`.** The liveness classifier
   feeds `renderSessionCount`, which counts `liveness === 'live'` — so a fourth value there would
   have silently dropped the dashboard header's active count by one the moment a wrap started.
   Wrapping is a property OF a live session, not an alternative to being live, and the two
   predicates are separate for that reason. Pinned by a test.
2. **The fail posture inverts `medusa-wake`'s, deliberately.** Same registry, opposite default:
   the wake gate fails CLOSED (an unreadable registry means "assume a wrap is running") because
   withholding a keystroke is its safe error, while a display fails OPEN, because painting
   "working" across every card from one broken read is worse than showing nothing. The payload
   still carries `null` and names it in `incomplete`, because `architecture.md` requires an
   unestablished read to name itself and `api-contract.md` documents the field for API consumers.
   Note precisely what that does NOT mean: nothing in `public/` reads `session.incomplete` today,
   the pre-existing `['active']` entry included, so it reaches the wire and no reader. The DISPLAY
   declines to claim, and the payload stays honest for whoever asks.
3. **The dot moved into `renderStatusDot`.** Four states with a real precedence rule is worth
   running rather than reading, and a guard over rendered markup passes happily against a dead
   branch. Two existing guards followed it, both strengthened rather than relaxed: the disclosure
   suite now supplies the REAL renderer (a stub would let it pass over a dot that had stopped
   rendering), and the degraded-reads guard keeps all three assertions at the new address and adds
   two, that the card delegates and holds no private copy of the markup.

**Unknown outranks wrapping.** The two reads are independent — the registry answers from the
server process whether or not tmux answered — so a card can be both at once. The unknown wins
because it is the rarer state and the only one carrying a remedy; a wrap that is running will
still be running on the next poll once tmux replies.

**Acceptance criterion MET, by a real wrap rather than by tests.** A sandboxed server was booted
from the worktree on a leased port (5091, released after) with an isolated `TANGLECLAW_HOME`, and
a real wrap was triggered over HTTP against a throwaway git repo — never the worktree, since a
wrap commits with `git add -A`. The operator's own install was untouched throughout (same pid
before and after).

| Phase | The card payload's `wrapping` |
|---|---|
| before | `false` — established-absent, `incomplete: []` |
| during a real wrap | `{"step": "changelog-update", "since": 1788738567080}` |
| after | `false` |

It turns on within a poll, carries the step the registry knows, and turns back off — which is the
criterion verbatim. The served `style.css`, `ui.js` and `api-helper.js` were fetched over HTTP and
confirmed to carry the pinwheel, the renderer and the classifier, so the frontend half is really
delivered rather than only present on disk.

**Six mutations, each run, each red**, and the tree restored green after: `null` collapsed to
`false`; the wrapping branch disabled; the precedence flipped; the field dropped from the
projection; a finished run read as still running; and a failed read treated as wrapping. The
projection-dropped mutation reds four tests, including the two that feed the SERVER's own output
into the REAL renderer — the pairing that exists precisely because asserting either realm against
a hand-written fixture is what let this feature ship invisible the first time.

**What is NOT verified: every pixel.** Nothing was rendered in a browser. Queued as
`VRF-5W9D-wrap-pinwheel` in `.prawduct/operator-verification.md` — non-blocking, since
`operator_verification_required` is unset on this repo.

**Found while verifying the boundary, filed not fixed: #1311.** `public/ui.js:1065` reads
`proj.session.sessionMode` to word the kill modal, and neither card projection has ever emitted
that field — so `isWebui` is permanently false and a webui session is told its kill "terminates
the tmux session". It is the same defect class as this chunk, one function over and pointing the
other way: a consumer with no field, rather than a field with no consumer.

### Chunk 03: The vestigial `V2` designators are retired

- **Description:** `_triggerWrapV2`, `_completeV2Wrap`, the "V2 lifecycle" log strings and the
  wrap-run-registry header's V2 references all distinguish a V2 from a V1 that no longer exists.
  #1034 bundles this rename with the ruling because it is the same reading pass.
- **Closes:** the remainder of #1034
- **Depends on:** Chunks 01 and 02 — renaming symbols that are about to be deleted or re-sourced
  would make both diffs harder to review.
- **Artifacts consumed:** none beyond the code.
- **Deliverables:** the rename, and nothing else. **`Type: trivial` is NOT claimed** — a rename
  that touches log strings changes operator-visible output, and the wrap pipeline is the product's
  most consequential path.
- **Tests:** existing suite green; any test asserting on a renamed log string moves with it.
- **Acceptance criteria:** no `V2` designator survives in `lib/` or `server.js` except where it
  names a genuine version of something that still has a V1; suite green.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. `/prawduct:critic` run and blocking findings resolved
  3. Committed, PR merged, chunk marked `[x]` in Status — Train 14 resumes at its Chunk 02

## Verification Strategy

Chunk 01 is a deletion, and the risk of a deletion is not that it breaks a test — it is that it
removes a path something still needed. Two checks beyond the suite:

- **The 166 historical rows stay readable.** `GET /api/activity?type=session.wrapping` returns
  them after the change. A retired event type must not become an unreadable one.
- **A real wrap runs end to end on this install** before Chunk 01 merges — this clone IS the live
  install, so the wrap path being edited is the one that wraps this very session.

Chunk 02 carries `**Visual change:** yes` and an operator-verification entry: whether a wrapping
card reads correctly on a phone is not something a test can speak to.

## Governance Checkpoints

- **After Chunk 01** — the deletion is the irreversible half. Review the trajectory: did anything
  the ruling assumed was dead turn out to have a live caller, and does the transition map cover
  exactly the four statuses that remain (`active`, `wrapped`, `killed`, `crashed`) with no fifth
  admitted from the issue's list?
- **After Chunk 03** — the cumulative review, and the point at which #1034 is closed and Train 14
  resumes.

## Chunk 03 built 2026-09-06 — the acceptance criterion held, and the rename broke the log

Built on `chore/1034-chunk03-retire-v2-designators`, in a worktree (the live-install rule keeps
`server.js` / `public/` work off the primary checkout). Two commits: the rename, and the findings
batch. Reviewed cumulative (0 blocking, 3 warnings, 14 notes — all 17 dispositioned) then
`verify-resolutions` (0 blocking, 0 warnings, 0 notes), which re-derived every warning from the
tree and confirmed all three fixed.

**The sweep's boundary, which is the whole of the acceptance criterion.** Five `V2` families live
in this codebase and only one is vestigial. Retired: the wrap family — `_triggerWrapV2` /
`_completeV2Wrap` / `_deriveV2WrapSummary`, five teardown log strings, and the comments that
narrated the V1 removal. Left alone, because each names a genuine version of something with a
genuine V1: the Prawduct V2 plugin (a `governed-vendored` V1 still exists as a live state),
MED-2K9P v2, ClawBridge's `/v2/session/*`, and the store's `v1→v2` schema migration. Two reviewers
verified that partition independently by grepping the whole tree.

**The rename introduced a regression, and three reviewers found it separately.** Dropping the
qualifier collapsed the pipeline teardown's log lines onto `completeWrap`'s: `Released document
locks on wrap` and its warn twin became byte-identical across both paths, and `... during wrap
teardown` is a strict superstring of `... during wrap`, so the shorter grep matched either. The
irony is exact — the commit's own argument is that "pipeline" is the real distinction *because*
`completeWrap` still exists beside it, and the log was the one place that distinction was
observable. Both paths can touch one session in a single wrap (the race `/wrap/complete` answers
409 `SESSION_CHANGED` for), so an operator triaging how a row ended could no longer tell which
finalizer ran. Restored in the structured context rather than the message: every line in
`_completePipelineWrap` carries `path: 'pipeline'`, every line in `completeWrap` carries
`path: 'finalize'`.

**The guard is derived, not enumerated.** It slices both function bodies and requires the field on
every `log.*` call it finds, so a line added later is covered the moment it is written. Its first
draft carried a third assertion — that the two paths still *share* a message — which mutation
showed reds when someone makes the messages distinct, i.e. it forbade the better fix. Dropped. The
verify pass re-implemented the parser independently and confirmed it finds all ten calls and is
not vacuous.

**`\b` does not match `_V2_`.** `EMPTY_V2_RESULT` survived the boundary-grep sweep for the same
reason `wrapV2` does, and was found by reading the diff rather than by any search. Every surviving
`wrapV2` is a retirement pin naming the real on-disk key and stays verbatim.

**#1302 was closed by accident, not by work.** Chunk 01's findings commit `1788f14` contained the
sentence "R-15 accepted, not **fixed**: #1302", and GitHub parsed `fixed: #1302` as a closing
keyword — the second recorded instance of that hazard. This chunk ships comments pointing at #1302
as the issue that retires the `wrapFinished` branches, so it was reopened before merge.
