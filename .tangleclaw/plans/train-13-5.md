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

## Status

- [x] Chunk 01 — #1314, the registry owns the staleness predicate
- [ ] Chunk 02 — #1245, ttyd child leak (code-side branches only)
