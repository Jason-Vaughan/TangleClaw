---
artifact: build-plan
version: 2
scope: unknown-not-fact-tail-905-907-906
depends_on:
  - artifact: architecture
  - artifact: api-contract
governed_by:
  - artifact: nonfunctional-requirements
    dispositions:
      - "mobile-first, ≥44×44px targets → applies to chunk 02's master status row if it grows a control; no new control is planned, so the existing Retry button is the only target touched"
  - artifact: security-model
    dispositions:
      - "secure by default → inapplicable: no auth, ingress or bind surface is touched; the new fields describe a read this payload already performed"
  - artifact: architecture
    dispositions:
      - "Direction: a dependency's failure degrades TangleClaw, never crashes it → this work IS that direction applied to three remaining reads"
      - "Direction: the degraded-read renderer reduces every payload shape to one {known, why, remedy}, each source supplying its own remedy → chunk 02 initially bypassed this with a bespoke sentence (Critic R-9/R-21); corrected by adding tcMasterRead as a fifth source rather than a fifth render path"
  - artifact: api-contract
    dispositions:
      - "the incomplete/cause convention (incomplete present on every answer, [] when nothing went short) → extended to master.exists and to every branch of the session-status route"
last_validated: 2026-08-15
---

# Build Plan — #906 + #905 + #907: the last three unknowns wearing a fact's clothes

**Work items:** GitHub #906, #905, #907 (all `bug`) · type=bugfix · size=M · three chunks
**Branch:** `feat/905-907-906-unknown-not-fact`
**Release train:** 5.3.0
**Critic mode:** `cumulative-final` — one `cumulative` over the whole branch, serving as the
last chunk's review.

> **Amended mid-build (2026-08-15), recorded rather than silently changed.** The plan opened
> with `chunk` per chunk plus a `cumulative`. Three per-chunk reviews would each see one call
> site of a mechanism whose whole risk is *cross-site consistency* — the shared condition log
> re-arming identically in three places, and the same tri-state convention landing the same way
> on three payloads. That is exactly what a chunk-scoped review cannot see and a cumulative can.
> The chunks are also small, tightly related, and land in one work cycle, which is the condition
> `methodology/building.md` names for a `cumulative-final` plan.

## Why these three, together

`#891` settled the rule and `#900`/`#908` built the primitive: a read that could not
establish a fact returns **unknown**, never a plausible default, and `tmux.probeSession(name)
→ {live, answered, cause}` is how a caller asks without flattening the third outcome.

Each of these three issues was named in that work's build plan as a **deliberate carve-out** —
out of scope then, not overlooked. They are the last three named surfaces, and they share one
root condition: the PTY-exhaustion wedge this install actually reaches (#94/#144/#380). A
wedged tmux is simultaneously the moment every one of these lies and the moment an operator
most needs the truth.

| Surface | Could not establish | What it reports today |
|---|---|---|
| `getMasterStatus` (`lib/master.js:665`) | tmux wedged, `hasSession` swallowed it | **master is not running** (#905) |
| `getSessionStatus` active branch (`lib/sessions.js:1591-1597`) | probe did not answer | **`idle: false, lastOutputAge: 0`** — a pane that just produced output (#907) |
| `_readSessionNames` (`lib/tmux.js:129`) | listing timed out | one ERROR line **every ten seconds, forever** (#906) |

The first two are the same defect as #900. The third is its operator-facing twin: the wedge is
honest in the log and then drowns itself.

## Confidence check

1. **Problem.** During a wedge, the Project Master reports as down, an active session reports as
   busy-with-fresh-output, and the log that would explain both is buried under six identical
   lines a minute.
2. **Success.** Each of the three reports *could not establish* distinctly from *established
   negative*; the dashboard and session page render the difference; and the wedge is loud once,
   quiet while it persists, loud again when it recurs after a recovery.
3. **Out of scope.** #910 (re-timing wrap finalization), #934 (Medusa ACK) — see below.

## Requirements Confidence

**High** for the payload half of all three chunks. `#891`'s null-not-default rule and `#900`'s
`{live, answered, cause}` shape are settled and in-repo; `_reportIncomplete` (`lib/git.js:90`) is
an existing, working implementation of exactly the log cadence #906 asks for, including the
argument for why it is per-process rather than per-interval. These chunks apply written rules to
named call sites rather than invent anything.

**Medium** for chunk 02's and chunk 03's rendering. Neither issue specifies what the operator
should SEE. Recorded as vetoable assumptions:

- `[ASSUMPTION: an unknown master renders as the existing neutral dot plus explicit status text
  ("Could not reach tmux — master state unknown") rather than as a fourth dot colour.]` A new
  colour is a new vocabulary item on a two-pixel affordance; the status row already carries
  words, and words are what distinguish "not running" from "could not look". Vetoable.
- `[ASSUMPTION: an unknown `idle` on the session page leaves the existing wrap-completion
  detection inert rather than showing a new badge.]` `null` is falsy, so every consumer that has
  not learned about this state behaves exactly as it did before — which is the correct default
  for a signal whose whole job is to fire on a certainty. Vetoable.

## Corrections to the filed issues

Recorded rather than absorbed, per the rule that a filed root cause is a hypothesis:

1. **#905 says "The panel offers Start Master on the strength of `exists: false`."** There is no
   Start Master button. `public/index.html:87-92` has a status row (dot, text, Retry, gear) and
   no start control; the start is *implicit* — `toggleMaster()` → `ensureMasterAttached()` →
   `POST /api/master/ensure` fires whenever the operator opens the panel. The defect the issue
   describes is real but reaches the operator by a different door: `refreshMasterDot()`
   (`public/ui.js:3429`) sets `live` only when `exists` is true and otherwise leaves the dot in
   its neutral state saying nothing, so a wedge is indistinguishable from a master that was
   never started. Opening the panel then fires an ensure that fails on the same unresponsive
   server and reports "Failed to start the master session" — blaming the start for a condition
   that predates it.
2. **#907's title names `getSessionStatus` generally; only the ACTIVE branch is still defective.**
   The wrapping branch already returns `idle: null, lastOutputAge: null` with
   `incomplete: ['idle','lastOutputAge']` — #908 fixed it there and argued the case in a comment
   at `lib/sessions.js:1650-1662`. Chunk 03 applies that same, already-argued treatment to the
   active branch. Do not re-derive the reasoning; cite it.
3. **A fourth site exists that no issue names.** `lib/sessions.js:1720` (the untracked-session
   branch) calls `tmux.hasSession(tmuxName)` and, on `false`, falls through to "no active
   session" — so a wedge makes an untracked-but-running session vanish, and on the `true` path
   returns `idle: false, lastOutputAge: 0` unconditionally. This is the read-only fleet question
   `#900` says must use `probeSession`, not the act-on-a-pane question `hasSession` is for.
   **In scope for chunk 03**, recorded here because finding it mid-build is exactly the moment
   the rule says to write the requirement down rather than carry it forward into code.

## Chunks

Ordered by ascending blast radius: the log cadence changes no payload, the master status changes
a small one, and the session status changes the surface an operator lives in.

### Chunk 01 — #906: loud once, quiet while it persists

**Files:** `lib/tmux.js`, `lib/sessions.js`, `test/`

- `_readSessionNames`'s timeout branch drops to `debug` on repeat, matching
  `_reportIncomplete`'s per-process rule (`lib/git.js:90`) — same mechanism, not a second one.
  Key on the condition, not the caller: there is one tmux server, so one key.
- The twin at `lib/sessions.js:1586` ("Could not establish whether this session is still live")
  gets the same treatment, keyed per session so one wedged pane does not silence another.
- **Recovery must re-arm.** A successful read clears the key, so a wedge that recurs after a
  recovery is loud again. This is the half a naive "warn once" gets wrong.

**Acceptance:** a wedge produces one WARN/ERROR and then debug lines; a recovery followed by a
second wedge produces a second loud line.

**Named mutations (each must go red):**
- delete the `.clear()` on the success path → the recurrence test stays quiet.
- key the tmux listing per-call instead of per-condition → the repeat test goes loud again.
- key the sessions.js warning globally instead of per-session → the two-panes test loses its
  second loud line.

### Chunk 02 — #905: the master's state can be unknown

**Files:** `lib/master.js`, `server.js` (contract only), `public/ui.js`, `test/`

- `getMasterStatus` uses `probeSession(MASTER_TMUX_SESSION)` and reports
  `exists: true | false | null`, plus `incomplete: []` / `['exists']` and `cause`, following the
  convention `session.active` and `git.dirty` already set. `incomplete: []` on the healthy path,
  **not absent** — a field that appears only on failure makes every consumer probe for its
  existence instead of reading its value (`lib/sessions.js:1690-1692` argues this).
- `refreshMasterDot()` renders the third state: neutral dot **plus** status text naming the
  condition, instead of silence.
- `ensureMasterAttached()`'s failure path distinguishes "the start failed" from "tmux never
  answered, so the start could not even be attempted honestly."

**Acceptance:** with a probe stubbed unanswered, `exists` is `null` and the panel says the state
is unknown; with a probe answering false, `exists` is `false` and behaviour is exactly as today.

**Named mutations:**
- `exists: null` → `exists: false` → the unknown test goes red.
- drop `incomplete` from the healthy payload → the always-present-field test goes red.
- render unknown through the same branch as down → the panel-text test goes red.

**Caller check (per the #895 lesson):** the fixture's input must be what `server.js:598` really
passes — `getMasterStatus()` with no options — not a hand-built options bag that only the test
produces.

### Chunk 03 — #907: an unreachable pane is not a busy pane

**Files:** `lib/sessions.js`, `public/session.js`, `test/`

- Active branch: when `probe && !probe.answered`, return `idle: null`, `lastOutputAge: null`,
  `incomplete: ['idle','lastOutputAge']`, `cause: probe.cause` — the treatment #908 already
  applied and argued on the wrapping branch.
- The untracked branch (site 4 above) moves to `probeSession` and reports unknown rather than
  reporting the session gone.
- `public/session.js` renders unknown rather than reading `null` as fresh output.

**As built, chunk 03's rendering half landed as a DESCOPE plus one correction — recorded here
because the plan promised a render and the shipped code deliberately does less (Critic R-6/R-19).**

- **Descoped: no new `idle` surface.** The two consequential readers of `idle` — the chime and the
  wrap-idle modal — already do the right thing on an unknown, because falsy means inertia for
  both. Inventing a badge for it would be a surface the operator has not seen and cannot veto
  while away. What shipped instead is a guard on the invariant that makes the falsiness safe: the
  server never emits a truthy `idle` beside an `incomplete` that names it.
- **NOT descoped, and originally missed: `active`.** The same falsy-is-safe argument **inverts**
  here, and two reviewers caught it independently. `public/session.js` acted on a falsy `active`
  by ending the session, stopping the poll, disabling Wrap/Kill/Command and starting a redirect —
  so `active: null` during a wedge made the page declare an end the server had refused to declare,
  with no way back because polling had stopped. Now branches on `active === false`. The plan's
  recorded assumption was right about `idle` and wrong about `active`; the distinction is whether
  falsiness produces *inertia* or an *action*.

**Acceptance:** an unanswered probe on an active session yields nulls and a populated
`incomplete`; the session page shows the state rather than "active, just produced output".

**Named mutations:**
- `idle: null` → `idle: false` → the unknown test goes red.
- leave the untracked branch on `hasSession` → the site-4 test goes red.
- have the page treat `null` as `false` without rendering → the render test goes red.

## Deliberately out of scope

- **#910** — a status poll finalizing a wrap and committing the operator's repo. It re-times when
  a wrap completes, the session page depends on that timing, and #105 exists because a stuck
  `wrapping` row bricks a project. Needs the operator watching a real wrap. Left open.
- **#934** — the Medusa ACK gap. Its filed root cause names `127.0.0.1:3100`; the consumer
  contract puts Medusa on HTTP 3009 / WS 3010, so the diagnosis is unverified and the fix would
  drive another project's live API. Overlaps #784. Left open.
- **Widening `hasSession` wholesale.** Most of its callers kill, adopt and type into panes, and for
  them `false` on a failed probe is the right conservative answer (`lib/tmux.js:201-205`). Only
  read-only callers move to `probeSession`.

  **Amended as built:** three call sites did move — `getMasterStatus` and `ensureMasterSession`
  (`lib/master.js`) and the untracked branch of `getSessionStatus`. `ensureMasterSession` is the
  one that needs saying out loud, because it *acts*: an earlier line of this plan implied only
  read-only callers would change. It moved because `false` there means "start one", so the
  conservative reading is not conservative at all — it starts a second master over a live one.
  A caller that acts still wants the third outcome when the action is destructive.

  An audit of every remaining `.hasSession(` caller in `lib/` found exactly one more read-shaped
  site — `lib/session-ownership.js#_liveness`, which returns `{live, source}` and nothing else.
  **Filed as #937** rather than folded in: separate subsystem with its own consumers, and widening
  an already-widened diff before its review landed was the wrong trade.

## Status

**SHIPPED as v5.3.0 (2026-08-15).** PR #938 (`f370d8f`); release PR #939 (`44b3f47`); tag `v5.3.0`. Issues #906/#905/#907 closed. Archived per the plan-archival rule — kept, not deleted, so the rationale survives.

- [x] Chunk 01 — #906 log cadence
- [x] Chunk 02 — #905 master status tri-state
- [x] Chunk 03 — #907 session status tri-state + untracked branch
- [x] Cumulative Critic review
- [x] PR opened
- [x] Merged
- [x] 5.3.0 cut
