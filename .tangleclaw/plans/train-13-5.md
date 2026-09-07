---
artifact: build-plan
version: 2
scope: train-13-5
branch: fix/1314-wrap-run-staleness
depends_on:
  - artifact: api-contract
  - artifact: architecture
  - artifact: nonfunctional-requirements
  - artifact: project-preferences
---

# Train 13.5 — Stability & Timeout Hotfixes

**Board:** `MASTER_ROADMAP` → Currently Executing → *Train 13.5: Stability & Timeout Hotfixes*.
Assigned to the Builder session (`TangleClaw`) by the Coordinator, 2026-09-07.

**Cars:** #1314 (wedged wrap run blocks server restart forever) · #1245 (ttyd child leak).

## Chunk Roster

| Chunk | Issue | Size | State |
|---|---|---|---|
| 01 | #1314 — the registry owns the staleness predicate | Medium | In progress |
| 02 | #1245 — ttyd child leak, code-side branches only | Medium | Not started — see Scoping Ruling |

### Scoping Ruling — #1245 (Operator, 2026-09-07)

The issue's own cheapest-first step is *"does a newer ttyd fix it?"*, i.e. `brew upgrade ttyd`.
That is **deferred until the Operator is physically at cursatory**, and the reason is not the
upgrade itself:

ttyd's TCC grants are keyed to the versioned Cellar path. Verified live 2026-09-07:
`kTCCServiceSystemPolicyDocumentsFolder | /opt/homebrew/Cellar/ttyd/1.7.7_6/bin/ttyd | auth_value=2`.
An upgrade mints a new path, macOS treats it as a new subject, and the grant is gone. That grant is
what carries the whole ttyd → tmux → claude chain, so every dashboard terminal loses `~/Documents`.
Re-granting requires clicking a GUI dialog, which SSH cannot do — so the outage would last until the
Operator is at the machine.

It cannot break SSH (`sshd` is a separate daemon) and it cannot brick the host. But #1245 itself
records the leak as **not urgent**: pool at ~9%, orphan gate holding, nothing user-visibly broken.
Trading a day of the Operator's working surface for a non-urgent investigation is the wrong trade.

**Chunk 02 is therefore scoped to the code-side branches only** — whether `deploy/ttyd-attach.sh`
`exec`s versus spawns the `tmux attach` child, and whether `-W`/idle-timeout is relevant. The ttyd
version bump is split out as its own issue, gated on physical presence.

---

## Chunk 01 — The registry owns the staleness predicate (#1314)

### Confidence Check

**Problem.** `lib/wrap-run-registry.js` defines `STALE_RUN_MS` and only `begin()` applies it. Every
reader of `run.running` believes a wedged run forever, so one pipeline promise that never settles
makes `POST /api/server/restart` answer 409 `WRAP_RESTART_BLOCKED` permanently and makes
`lib/medusa-wake.js` skip every nudge for that project permanently.

**Success.** With a run wedged past `STALE_RUN_MS`: the restart route accepts, the wake monitor
resumes nudging, the dashboard card reports the wrap as stale rather than either spinning forever
or silently vanishing, and a stream opened on it closes with its replay instead of hanging. All four
driven by injected time in tests, not by waiting 30 minutes.

**Out of scope.** Reaping `_runs`; persisting run state; changing `STALE_RUN_MS`; any change to
`begin()`'s existing takeover behaviour; #1245; #1302.

### Requirements Confidence — High

The mechanism is read, not inferred. `_internal.now` is already injectable, so every branch is
reachable from a test.

### The four readers

The issue names three. There are four. Scope is all of them.

| # | Reader | Reads | Fail posture | Under `_isLive` |
|---|---|---|---|---|
| 1 | `server.js:979` restart gate | `anyRunning()` | closed (refuses) | Stale ⇒ restart allowed |
| 2 | `lib/medusa-wake.js:1201` wake gate | `get().running` | closed (withholds) | Stale ⇒ nudges resume |
| 3 | `lib/projects.js` `_wrapState` | `get()` | open (no pinwheel) | Stale ⇒ reported stale, not absent |
| 4 | `wrap-run-registry.js` `subscribe()` | `run.running` | n/a | Stale ⇒ `finished: true`, stream closes |

**The fail postures are NOT to be unified.** Readers 1 and 2 take an action and fail closed; reader
3 is a display and fails open. That split is action-vs-display and is load-bearing — #1314's own
text says so, and `_wrapState`'s docblock explains it. This chunk changes what "running" *means*,
not which way any reader fails when the read *throws*.

### Design decisions

**D1 — One predicate, in the registry.**

```js
function _isLive(run) {
  return Boolean(run && run.running && (_internal.now() - run.startedAt) < STALE_RUN_MS);
}
```

`begin()`, `get()`, `anyRunning()` and `subscribe()` all ask it. The finding is that three readers
each reimplemented a check that drifted; the fix is one place that can answer.

**D2 — A stale run reports `running: false`, and says why.**

`get()` returns `running: false` for a stale run, so both boolean consumers become correct with no
change to their own logic — the safe answer is the default, including for any reader added later
that never hears about staleness. The extra information rides alongside as an explicit
`stale: true`, with `startedAt` retained, so the one consumer that wants more can have it.

Rejected: returning a third truthy value for `running`. It would make every existing boolean reader
wrong-by-default, which is the exact failure being fixed.

**D3 — The card says "stale", not "no wrap".**

`_wrapState` gains a fourth answer. `false` currently means *established that no wrap is running* —
a wedged run is not that, and flattening it to `false` would hide a real fault behind a plausible
one. `lib/projects.js` already carries an `incomplete`/`cause` vocabulary for exactly this shape.

**D4 — Report, do not reap.**

Reaping `_runs` would drop `finishedAt`/`result`, which the stream route replays, and `begin()`
already recovers the slot on the next wrap. Reporting is strictly more information at strictly less
risk.

**D5 — One threshold, not a per-reader one.**

#1314 asks whether 30 minutes is right for a *reader*, whose cost of being wrong differs from
`begin()`'s. Keeping one constant, because a second threshold recreates in a new place the very
drift this fixes. Revisit with evidence, not in advance.

**D6 — `subscribe()` folds in.**

A wedged run will never emit again, so a stream held open on one hangs its client forever — the same
bug in stream form. A stale run replays its log and reports `finished: true`. Deliberate, not
incidental: this is the reader #1314 does not mention.

### Done when

- [x] `_isLive` exists in `lib/wrap-run-registry.js` and is the only staleness test in the module.
- [x] `get()` reports `running: false` + `stale: true` past `STALE_RUN_MS`; `anyRunning()` skips it;
      `subscribe()` returns `finished: true` for it.
- [x] `begin()`'s takeover behaviour is unchanged (its existing tests still pass untouched).
- [x] `_wrapState` reports a stale run distinctly from both "wrapping" and "no wrap".
- [x] Regression tests drive every branch through injected `now`, and each one is mutation-checked:
      break the code, watch the test go red.
- [x] Full suite green; `prawduct-hook test-evidence record`.
- [x] `/prawduct:critic`, findings dispositioned in one pass.
- [x] CHANGELOG `[Unreleased]` entry under `### Fixed`.

### What the review added — the reader table was short by three

The table above enumerates the readers inside `lib/wrap-run-registry.js` and stops at the module
boundary. `get()`'s payload is also the `GET /wrap/status` response body, and three more readers
live past it (`boundary-patterns.md` → API Endpoints). Two act on falsy as inertia and are safe;
`wrapWatchDecision` (`public/wrap-drawer.js`) takes an ACTION on it, and with `running` newly false
for a wedged run it told the operator the pipeline died and nothing was committed — inviting a
second wrap at exactly the moment `begin`'s takeover would permit one. All three reviewers reached
it independently.

The reachability argument is the part worth keeping: `STALE_RUN_MS` is 30 minutes against a ~17
minute worst observed wall-time, so the case that actually fires is a **slow-but-alive** wrap, not
only a wedged one. Staleness is a reader's heuristic, never an observation of death, and no surface
may phrase it as one.

Two further consequences of the same short table:
- The SSE route closes on `finished`, which `_isLive` made reachable for a run with no `run-done`
  in its log. A browser reads a terminal-frame-less close as a dropped connection and reconnects
  forever. `subscribe` now synthesises the terminal frame (never appends it — a read must not write
  to the log, and the run may still settle).
- The status route hand-copies the registry payload field by field, so `stale` stopped at the HTTP
  boundary while the reference documented it. The route's key SET is now pinned by a test, so the
  next added field fails there rather than going missing.

Deferred as #1321: nothing logs that a run crossed the threshold, so an operator cannot reconstruct
why a restart was permitted or why nudges resumed. The clean fix makes a read mutate the entry,
which is the property this chunk was careful to preserve — it deserves its own thought.

---

## Chunk 02 — The mitigation stops seeding its own next trigger (#1245)

### What the investigation found (2026-09-07, this machine)

The ttyd leak itself is NOT fixable from this repo — it is ttyd 1.7.7 failing to reap the
`tmux attach` child it spawns per websocket, and those children wedge in the macOS kernel `E`
state where nothing but ttyd dying reclaims them. The version bump that might fix it is deferred
by Operator ruling (see the Scoping Ruling above). **This chunk does not claim to fix the leak.**

Three things the investigation established, each of which narrows or corrects the issue:

1. **"Does `deploy/ttyd-attach.sh` hold the child open?" — answered NO.** The script ends with
   `exec tmux attach-session`, so ttyd's direct child IS `tmux attach`; there is no intermediate
   bash for ttyd to lose track of. 17 of 18 wedged processes observed were direct `(tmux)` children
   of ttyd. That hypothesis closes without code.

2. **The `-W` hypothesis is a misreading of the flag.** `-W` is `--writable` and is already set; it
   is not an idle timeout. The flags that bear on peer detection are `-P/--ping-interval`
   (default 5s) and `-m/--max-clients` (unlimited); neither is configured, and neither addresses a
   child that wedges AFTER a clean disconnect.

3. **The mitigation thrashes, and that IS fixable here.** 13 kickstarts over two days, clustering
   at 20 min and — once — **5 minutes**, which is one poll interval:

   | time (UTC) | orphans | gap |
   |---|---|---|
   | 09-07T00:34 | 24 | — |
   | 09-07T01:09 | 29 | 35 min |
   | 09-07T01:14 | 22 | **5 min** |
   | 09-07T01:34 | 21 | 20 min |

   `_check` reads `pid` fresh every tick and `_countTtydOrphans(pid)` counts children of that
   pid, so the 01:14 reading of 22 was against the NEW ttyd (pid 14240 → 67690 confirms the
   restart happened). **A fresh ttyd accumulated 22 wedged children within five minutes.**

   The mechanism is the mitigation's own side effect: a kickstart blanks every open terminal
   iframe simultaneously, they all reconnect at once, and connect/disconnect churn is what leaks.
   So the orphan gate can fire on damage its previous kickstart caused. Each round is user-visible
   — every terminal blanks — which is the papercut #1245 names.

### Confidence Check

**Problem.** The orphan gate re-fires on the reconnect burst its own kickstart produced, so the
operator's terminals blank two or three times in twenty minutes for one underlying leak.

**Success.** A kickstart is followed by a settling period in which the ORPHAN gate will not
re-fire; the PTY-pool gate is unaffected and still fires immediately, because pool exhaustion is
the actual emergency. The log says plainly when a kickstart is being suppressed and why, and what
the orphan count was on the tick after a kickstart, so the reclaim is visible.

**Out of scope.** The leak itself; upgrading ttyd; `--max-clients`/`--ping-interval` tuning;
changing the frontend's reconnect behaviour; the pool-ratio gate's threshold or logic.

### Design decisions

**D1 — The cooldown binds the ORPHAN gate only, never the pool gate.** Observed pool ratios are
0.084–0.115 against a 0.85 threshold, so the pool gate has never fired here — it is the true
safety net for actual exhaustion and must keep its ability to fire on any tick. Gating it too
would trade a papercut for the #94 incident.

**D2 — Suppression is logged at `warn`, not swallowed.** A gate that declines to act is exactly
the thing an operator later needs to explain why terminals were blanking, or why they weren't.
This is the same argument as #1321 and it applies with more force here, because the suppression is
a decision rather than a measurement.

**D3 — Report the post-kickstart orphan count.** Nothing today distinguishes "the kickstart
reclaimed the children and they came back" from "the kickstart did not reclaim them". The tick
after a kickstart now says which, which is what makes the thrash diagnosable rather than inferred.

**D4 — `exec` the wrapper's no-session branch.** One of the 18 wedged processes was a `(bash)`
holding a `(tmux)` child — the non-exec'd window. The `else` branch sits in `sleep 30` as a live
bash for 30 seconds per failed attach. Small, in the same family, and correct regardless.

### Done when

- [ ] The orphan gate does not fire within the cooldown of a previous kickstart; the pool gate is
      demonstrably unaffected.
- [ ] A suppressed kickstart logs why, with the elapsed time and the orphan count.
- [ ] The tick after a kickstart reports the observed orphan count.
- [ ] `deploy/ttyd-attach.sh`'s no-session branch execs.
- [ ] Every new branch mutation-checked against a green control.
- [ ] Full suite green; evidence recorded.
- [ ] `/prawduct:critic`; findings dispositioned in one pass.
- [ ] CHANGELOG entry under `### Fixed`.

## Status

- [x] Chunk 01 — #1314, the registry owns the staleness predicate
- [ ] Chunk 02 — #1245, the mitigation stops seeding its own next trigger
