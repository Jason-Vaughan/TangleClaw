---
artifact: build-plan
version: 2
scope: degraded-reads-900-885
depends_on:
  - artifact: architecture
  - artifact: api-contract
governed_by:
  - artifact: nonfunctional-requirements
    dispositions:
      - "mobile-first, ≥44×44px targets → applies to chunk 03's badges and notice row"
  - artifact: security-model
    dispositions:
      - "secure by default → inapplicable: no auth, ingress or bind surface is touched; the new fields expose a path the payload already carried"
last_validated: 2026-08-13
---

# Build Plan — #900 + #885: an unknown must not render as a fact

**Work items:** GitHub #900 (bug) + #885 (feature) · type=feature · size=M · three chunks
**Branch:** `feat/885-900-degraded-reads`
**Critic mode:** `chunk` per chunk; `cumulative` before the PR.

## The one defect, in two places

Every read behind the dashboard has three outcomes — *yes*, *no*, and *we could not
establish it* — and the payload has fields for two of them. The third is rendered as the
second, so the operator is shown a definite answer where the system has none:

| Read | Could not establish | What the dashboard shows today |
|---|---|---|
| Session liveness (`tmux list-sessions`) | server wedged / did not answer | **no session** (#900) |
| Unregistered-folder scan | directory did not answer, or the walk ran out of budget | **a shorter list, silently** (#885) |
| A registered project's own directory | TCC / timeout / collateral abort | payload carries `unreadable*`; **nothing renders it** (#885) |
| `git.getInfo` fields | budget spent, git refused | payload carries `incomplete`; **nothing renders it**, and `cause` never leaves the log (#885) |

#891 already settled the rule for the git case — a field the read could not establish comes
back `null` and is named, never as a plausible default (`dirty: false` became `dirty: null`).
`architecture.md` § Direction ratifies the general form: *a dependency's failure degrades
TangleClaw; it never crashes it* — and its 2026-08-09 correction records that the degradation
is currently invisible, naming #885 as the open half. This plan applies the settled rule to
the one read that still breaks it, and then renders all four.

## Confidence check

1. **Problem.** A wedged tmux server makes every running session vanish from the fleet view,
   and an unreadable projects directory makes folders vanish from the list — both silently,
   both stating a fact the server does not have.
2. **Success.** For each of the four reads the response distinguishes *could not establish*
   from *established negative*, and the dashboard shows the difference on the card, in the root
   panel, and in the card detail — with the remedy where one exists.
3. **Out of scope.** See "Deliberately out of scope" below.

## Requirements Confidence

**High** for what the reads must report. Both issues state the required distinction directly, the
payload half of #885 already shipped (`unreadable`/`unreadableHint`/`unreadableCode`), and #891
settled the null-not-default rule that chunk 01 applies to liveness. `api-contract.md` documents the
existing shapes, so the new fields extend a written contract rather than invent one.

**Medium** for chunk 03's rendering. Neither issue specifies what the operator should SEE — badge
versus row versus banner is a judgement call, and the constraints that bind it (no timer-driven UI,
mobile-first ≥44×44px) come from `project-preferences.md` and `nonfunctional-requirements.md` rather
than from the issues. `[ASSUMPTION: an always-present notice row under the ROOT panel, and a
per-card badge, are preferable to a dismissible banner — the state is a fact about the current poll,
so it must clear itself rather than be dismissed.]` Vetoable by the operator at chunk 03.

**Two requirements surfaced during chunk 01's review and are recorded here rather than absorbed
into code**, both the same defect one layer deeper than the issue looked:

1. **A read may not record a death it did not observe.** `getSessionStatus` marked a session
   `crashed` on `!hasSession(...)`, so one poll from an open session page during a wedge persisted
   the lie — and unlike the display, the row does not recover when tmux does. The plan's original
   carve-out ("`hasSession`'s callers kill, adopt and type into a session, so `false` is the right
   conservative answer") does not cover a status read that writes. Fixed in chunk 01.
2. **Nor may an operator action clear one.** `launchSession` cleared the same record before
   starting a second session over the first. Under a wedge that launch fails anyway — creating a
   session needs the server that just refused to answer — so the honest outcome is a refusal that
   changes nothing, not a mangled record plus an obscure failure. This is new operator-visible
   behavior (a new refusal path with its own message), which is why it is written here first.

Both are served by `tmux.probeSession(name)` → `{live, answered, cause}`; `hasSession` becomes its
boolean face and keeps its conservative contract for the callers that act.

## Design

### Chunk 01 — liveness that could not be read is unknown (#900)

`lib/tmux.js` `_readSessionNames` resolves a **verdict**, not a bare `Set`:

```js
{ names: Set<string>, answered: boolean, cause: string|null }
```

- success → `{ names, answered: true, cause: null }`
- **stopped by our own timeout** → `{ names: ∅, answered: false, cause: 'read-timed-out' }`
- any other failure → `{ names: ∅, answered: true, cause: null }`

`cause` reuses #895's vocabulary (`read-timed-out`) so one renderer can speak about a git read
and a tmux read in the same words.

**Only a stop we caused is an unknown, and the asymmetry is the design.** #895 draws the same
line for git with `weStopped`. A tmux that *replied* — including the exit-1 `no server running`
that is the ordinary state of a machine with no sessions, and a missing `tmux` binary — told us
something, and that something is "nothing is live". Widening unknown to every error inverts the
bug rather than fixing it: after a reboot every stale `active` row would read *unknown* forever
instead of being cleaned up, on every machine where tmux is simply not running. The wedge this
issue is about (#94/#144/#380, PTY exhaustion) is precisely the case where the client hangs and
we kill it.

`enrichProject` (`lib/projects.js`) then has three branches where it had two. When the DB holds
an active (or wrapping) session with a tmux handle and the snapshot did not answer:

```js
session = { active: null, status, startedAt, tmuxSession,
            incomplete: ['active'], cause: <verdict.cause> }
```

`active: null` mirrors `git.dirty: null`, and it is what makes this safe for every existing
consumer: all seven read `project.session && project.session.active`, so a null reads exactly
as today's "not active" — no consumer changes behavior until chunk 03 teaches one to look.
`incomplete` / `cause` are present on the healthy object too (`[]` / `null`), because a field
that appears only on failure makes every consumer probe for its existence instead of reading
its value — the same rule `unreadable` already follows.

**Laziness is load-bearing and must survive.** The snapshot is only consulted inside the
branches that have a tmux handle to ask about; a fleet whose projects have no sessions must
still spawn nothing (#890).

### Chunk 02 — the list says whether it is complete (#885, payload half)

`listAllProjects` returns `{ projects, scan }` instead of a bare array. `scan`:

| Field | Meaning |
|---|---|
| `dir` | the directory that was (or was not) walked |
| `complete` | `false` whenever the list is short for any reason |
| `code` | `null` \| `DIR_MISSING` \| `SCAN_TIMEOUT` \| `SCAN_CACHED` \| `SCAN_ABORTED` \| `SCAN_FAILED` \| `SCAN_TRUNCATED` — consumers branch on this, never on prose |
| `reason` | one human sentence |
| `hint` | the remedy, present only when the failure is the shape it fits (`_scanFailureHint`'s existing rule: a collateral abort earns no Full Disk Access advice) |
| `listed` | how many unregistered entries the walk did report before it was cut off (`SCAN_TRUNCATED` only, else `null`) |

`GET /api/projects` answers `{ projects, scan }`. Existing clients read `data.projects` and are
unaffected.

`SCAN_TRUNCATED` is the case the issue asks to keep distinct in the opposite direction: the
list is short because the directory is large or the disk is slow, and *nothing is broken*. It
must not carry a Full Disk Access hint.

`lib/git.js` `getInfo` puts the `cause` it already computes on the object it returns, so the
reason a field is missing travels with the field instead of living only in the log.

### Chunk 03 — the dashboard renders the four seams (#885, surface half)

**Normalise once, at the render boundary.** The payload now carries SIX degraded-read
representations, each with its own shape: `session.active: null` + `incomplete`/`cause`,
`git.dirty: null` + `incomplete`/`cause`, the per-project `unreadable`/`unreadableHint`/
`unreadableCode` trio, and the list-level `scan` block. They are shaped differently because they
answer different questions, and flattening them in the payload would lose that. The renderer's
job is the opposite: reduce all six to one internal `{ known: boolean, why: string|null,
remedy: string|null }` so the dashboard speaks about them consistently and a seventh source added
later has one place to join. Do NOT let six shapes become six render paths.

Pure decision helpers first (this is how the frontend is testable here — see
`tcWrapWatchDecision`): `tcSessionLiveness(project)` → `'live'|'none'|'unknown'`,
`tcScanNotice(scan)` → `{text, hint, kind}|null`, `tcGitDirtyState(git)` →
`'clean'|'dirty'|'unknown'`. Unit-tested directly; the render sites are pinned structurally.

**Two remedies chunk 03 owns, both deliberately left as rendering decisions:** an `EACCES`
projects directory arrives as `SCAN_FAILED` with a null `hint` (honest, but the operator gets no
advice — the renderer should supply one), and `SCAN_CACHED` means "not being retried right now",
which is worth saying alongside the remedy it does carry.

- **Root panel** — when `scan.complete === false`, a notice row under the ROOT line: the
  sentence, the remedy when there is one, and a count that stops implying completeness.
- **Card** — an `unreadable` project gets a warning badge whose tooltip carries
  `unreadable` + `unreadableHint`; a session whose liveness is unknown gets a distinct status
  dot (glyph + tooltip, never colour alone); `git.dirty === null` renders as `?`, not clean.
- **Card detail** — the Git row names the cause; the Session row says unknown rather than
  "No active session".

Binding constraints: no timer-driven UI lifecycle (`project-preferences.md`) — this is state
the poll carries, and it clears itself when the read recovers; iPhone Safari 320–375px with
≥44×44px targets (`nonfunctional-requirements.md` § Direction).

**`public/` IS the live install, and that changes how this chunk is built.** The server serves
`public/` straight off this working tree, so an edit to `ui.js` or `style.css` reaches the
operator's browser on their next reload — before review, before merge, from a feature branch.
Chunks 01 and 02 touched only `lib/` and `server.js`, which need a restart and therefore could
not leak; chunk 03 cannot make that claim. Two consequences: the operator should know an
in-progress dashboard may appear mid-build, and `sw.js` `CACHE_NAME` gets bumped if the asset
list changes. Consider building it in a worktree instead, which is the only way to keep the
live install on `main` while this is written.

## Deliberately out of scope

- **`tmux.hasSession` keeps returning `false` on a failed probe.** Its callers kill, adopt and
  type into a session; for them the conservative answer is the correct one. #900 scopes to the
  read-only fleet view and says so. The exceptions are the two callers above that PERSIST or REFUSE
  on the answer — they take `probeSession` instead.
- **The sweep of the remaining `hasSession` sites, corrected TWICE — which is the finding.** Two
  successive versions of this list concluded "the rest only act on the answer" and both were wrong,
  so the enumeration rule is now written down instead of the conclusion: ask whether a caller's
  `false` branch **writes** anything — a DB row, a ledger entry, a commit, a teardown — not what
  the call site appears to intend. The kill, send-keys, adopt and capture sites genuinely do act on
  the pane immediately, so a failed probe costs a failed action and not a false record.
  **Three do not, and are on #908's census:** `lib/sessions.js` `_deferEngineInit`'s prime-paste
  guard writes a durable delivery-ledger row (`skipReason: 'tmux session ended before the prime was
  pasted'`) for an ending nobody established, and two more — `lib/sessions.js:136` and `:1544` reach
  `autoCompleteWrap` on `!hasSession(...)`, which writes the wrap as complete, tears down the
  session's Medusa listener, and calls `_autoCommitIfDirty` — **a real `git commit` in the
  operator's own repository**, on a probe that may never have answered, with no recovery when tmux
  returns. Not folded in here because declining to auto-complete interacts with #105 (a stuck
  `wrapping` row bricks the project) and that interaction needs stating and guarding rather than
  assuming. Filed as **#908** — the most consequential member of this family.

  **NO LONGER OUT OF SCOPE — all three census members were fixed on `fix/908-wrap-probe`, stacked
  on this branch (2026-08-13).** The #105 interaction was stated and guarded rather than assumed,
  which is what the deferral was waiting for: the age recovery was nested *inside* the liveness
  branch, so a naive refusal would have skipped it and left the row stuck — age is now settled
  first, and an unanswered probe can add an outcome but never withhold recovery. The prime-paste
  ledger row now records what was actually established. **The deeper defect that `getSessionStatus`
  finalizes a wrap at all — a read that mutates — is #910, deliberately unfixed.**
- **`getSessionStatus`'s `idle`/`lastOutputAge` still report `false`/`0` during a wedge**, which is
  the same unknown-as-fact shape on the session page rather than the dashboard. Left because the
  session page is not #885's surface and the values are consumed as a wrap-completion signal whose
  semantics need their own decision. Filed as **#907**.
- **`session-ownership.js` `_liveness`** — same reason: it feeds the prime-generation scope
  guard and the migration live-check, both acting callers.
- **`master.js` `getMasterStatus`** — genuinely the same defect on a different surface (a
  wedged tmux reports the Project Master as absent), but it is a separate boolean with no
  snapshot behind it and no relation to the projects payload. Filed as **#905**.
- **The per-poll log cadence.** A wedged tmux writes an ERROR line every ten seconds forever —
  the flood shape #884 removed from the scanner. Pre-dates this work; filed as **#906**.
- **#889's synchronous-read sweep** and the unverified TCC probe (`stat` vs `open` from a
  launchd process without Full Disk Access) — both carried, neither touched here.
- **`public/setup.js` still draws `git.dirty: null` as clean** (`public/setup.js:584`, building
  `${p.git.branch}${p.git.dirty ? ' (dirty)' : ''}` from `POST /api/setup/scan`). Same defect, a
  different surface: the first-run wizard's candidate list, not the dashboard. Left because the
  wizard is a one-time list of folders the operator has not adopted yet, where a working-tree
  state is decoration rather than a fact anyone acts on — and because the wizard's own degraded
  path was rebuilt for #859 and is worth changing deliberately rather than in passing. **Named
  here rather than passed over, because this branch's own recurring finding is a sweep whose
  conclusion outran its search.** Filed as **#909**.
- **The header session count was NOT left out.** Chunk 03's first pass rendered `?` on the cards
  while `renderSessionCount` still reported "0 active sessions" during the same wedge — the cards
  and the header contradicting each other. It now counts the three outcomes separately. Recorded
  because the plan's card/panel/detail list did not name the header, and "the plan did not say to"
  is not a reason for a surface to keep stating a fact it does not have.

## Tests — every guard names the mutation it must catch

| # | Guard | Mutation it must go red on |
|---|---|---|
| 1 | The snapshot reports `answered: false` when a REAL tmux is killed by our timeout | resolve `answered: true` on the timeout path (today's behavior) |
| 2 | The snapshot reports `answered: true` for an exit-1 `no server running` | call every error unanswered — a rebooted machine would then hold every stale row at *unknown* forever |
| 3 | A successful listing reports `answered: true` with the names | — (pins the healthy shape the two above are measured against) |
| 4 | `enrichProject` reports `active: null` + `cause` when the snapshot did not answer | drop the unanswered branch → `session: null` (today's lie) |
| 5 | `enrichProject` still reports `session: null` when tmux ANSWERED and the name is absent | make every miss unknown — unknown must not swallow the honest negative |
| 6 | The snapshot is not consulted for a project with no session row | consult it unconditionally → spawn count > 0 with a stub counter (#890's laziness) |
| 7 | `scan.complete === false` with the right code for each failure shape — timeout, cached, outright failure, missing directory — and `complete: true` reachable on the healthy path | return the healthy `scan` on the failure path |
| 7b | A cached refusal is coded `SCAN_CACHED`, from a fixture carrying **both** `tcTimedOut` and `tcCached` — the shape `dir-scanner.js` `_notAnswering` really builds — and still carries the remedy, because the directory still is not answering | check `tcTimedOut` before `tcCached`, which reports every backoff as a fresh timeout |
| 8 | `SCAN_TRUNCATED` carries no Full Disk Access hint | hand truncation to `_scanFailureHint` |
| 9 | `GET /api/projects` body carries `scan` | drop it from the route's response |
| 10 | `getInfo` returns `cause` alongside `incomplete`, and `null` rather than `'complete'` when nothing went short | return `incomplete` only |
| 11 | `tcSessionLiveness` / `tcScanNotice` / `tcGitDirtyState` matrices | each collapses unknown into its negative |

Guards 1–3 drive the classification through a **real** failing/slow executable, not a stubbed
exec, per the #891 learning that a stubbed timeout proves nothing about `execSync`'s error shape.

## Artifacts to update in the same commits

- `.prawduct/artifacts/api-contract.md` — the `scan` object, `session.active: null`, git `cause`;
  the existing note "Rendering these is #885" becomes a description of what renders them.
- `.prawduct/artifacts/architecture.md` § Direction — its 2026-08-09 correction says the surface
  is missing; that stops being true in chunk 03.
- `CHANGELOG.md` `[Unreleased]` → `### Fixed` (#900) and `### Added` (#885).
- `.prawduct/change-log.md` tagged entries per chunk.
- `.prawduct/operator-verification.md` — chunk 03 is a visual change.

## Status

- [x] Chunk 01 — tmux verdict + `enrichProject` unknown branch, guards 1–6, `/prawduct:critic chunk`.
- [x] Chunk 02 — `scan` on the list and the route, git `cause` on the payload, guards 7–10,
      `api-contract.md` updated, `/prawduct:critic chunk` (ran as `cumulative`; a clean tree
      refused chunk mode).
- [x] Chunk 03 — the four seams render, guard 11, `architecture.md` corrected, operator
      verification enqueued. `/prawduct:critic cumulative` + PR still to run.

**Chunk 03, as built.** Three decisions departed from the plan's sketch and are recorded here
because each is load-bearing:

1. **The helpers live in `public/api-helper.js`, and no new asset was created.** The plan
   anticipated bumping `sw.js` `CACHE_NAME` "if the asset list changes". It did not change:
   `api-helper.js`, `ui.js` and `style.css` are already in `NETWORK_FIRST_PATHS`, so a plain reload
   serves the new code. This is not only convenience — bumping `CACHE_NAME` on a feature branch
   behind the basic_auth gate is what locked the operator out of Chrome on 2026-07-28, and a new
   cache-first pure-helper sibling of a network-first script is the version skew the `wrap-drawer.js`
   comment documents.
2. **One vocabulary of causes, deliberately NOT one vocabulary of remedies.** `read-timed-out`
   means a wedged tmux server for a session and a protected folder for a directory scan. A shared
   code→remedy table — the obvious reading of "normalise to one record" — would advise Full Disk
   Access because tmux hung. Causes normalise; advice is per-source, and prefers the sentence the
   server authored at the failure site.
3. **Two render helpers were extracted that the plan did not name** (`renderSessionDetail`,
   `renderGitDetail`), because `toggleCardDetail` reaches for the DOM and a source-regex guard over
   it survived its own mutation. The extraction is what made the third state testable rather than
   merely asserted about.

**Archived cards deliberately carry neither badge.** `renderArchivedCard` renders no git, engine or
version detail at all, so the unreadable badge's whole rationale — *the detail you expect is
missing, and here is why* — has nothing to attach to. Stated here rather than left ambiguous,
because "an unreadable project gets a badge" read literally covers them.

**Four observations the verify pass demoted, carried rather than dropped.** All non-gating; the
coverage gate is satisfied at `a19431f`, so each of these costs a review round to land and none was
worth one on its own. Whoever opens the PR should batch them into ONE commit if they land at all:

1. **"The reason is above" can point at nothing.** The empty-and-short branch of `renderProjects`
   tells the operator the reason is in the ROOT panel, but `renderRootPanel` returns `''` while
   `state.config.projectsDir` is unset — the first-paint window before `/api/config` lands, and
   permanently if config never loads. Narrow (the next poll fixes it) and it is a broken
   cross-reference rather than a false claim about the system, which is why it did not earn a round
   by itself.
2. **The absent `role="status"` is unpinned.** Dropping the live region was deliberate — the grid is
   rebuilt every ten seconds, so it would re-announce every poll — but that reasoning lives only in
   a code comment. A later "add a live region for accessibility" edit meets no guard.
3. **The hostile-key guard covers two of the four null-prototype tables.** `TC_CAUSE_TEXT` and
   `TC_GIT_FIELD_TEXT` are exercised; `TC_CODE_REMEDY` and `TC_CODE_NOT_RETRYING` are keyed by
   payload values too and are not.
4. **#906's log flood is live in what ships.** Resolved by widening the issue, not by code — a
   wedged tmux now writes an ERROR+WARN pair per poll from `getSessionStatus` as well as the
   dashboard's ten-second poll.

**Guard 11 was built as behaviour, not source-matching, after two source guards proved vacuous** —
one satisfied by a dead branch, one by a substring collision (`badge-git-unknown` contains
`git-unknown`). Pure renderers are lifted out of `ui.js` and executed. Every guard in
`test/degraded-reads-frontend.test.js` has been falsified by mutating the code it covers.

Context: built 2026-08-13 on `feat/885-900-degraded-reads`, in the primary checkout. The
invariant is zero test failures at every commit on this branch; re-derive counts with the
declared `test_command` rather than trusting a figure quoted here.
