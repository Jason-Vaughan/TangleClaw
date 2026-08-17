# Plan — #755: the Master's access level becomes real

**Status:** OPEN — not started. **Milestone:** Master Control (#829). **Issue:** #755.
**Predecessors:** #756 (launch mode, shipped v5.5.0) · #768 chunks 1–2 (the shared settings
component and the control bar, shipped 2026-08-17 — the bar's READ/WRITE toggle ships **dim** and
this plan is what lights it).
**Shared artifact:** <https://claude.ai/code/artifact/a336d82a-05a5-4354-a9d5-adc86aaf5e50> — mirrors
this file; update the SAME link in place as this plan evolves, never mint a new one.
**Requirements Confidence:** **High** for the enforcement half — two operator rulings on 2026-08-17
settled the surface, the immediacy semantics and the engine question. **Medium** for scope: see
"The one thing #755's title promises that this plan does not deliver".

**Governed by:** `security-model.md` § Direction (secure by default, opt-out not opt-in) ·
`nonfunctional-requirements.md` § Direction (mobile + ≥44px, accessibility floors) ·
`project-preferences.md` § Direction (no npm deps, CommonJS, `node:test` coverage, JSDoc) ·
`data-model.md` § Direction (the Master has no sessions/projects footprint) · the no-UI-timers
norm (#98/#268).

---

## The headline, in one sentence

**The Master's access level is a picker with two permanently-disabled options and a guard that was
never told the level exists** — this plan makes the level a live value the guard reads on every
write attempt, so flipping READ→WRITE binds on the Master's very next tool call with no restart.

## What is actually there today — verified against the tree at `5e6a542`

| Piece | Where | State |
|---|---|---|
| The three tiers | `lib/master.js:75` `MASTER_ACCESS_LEVELS` | all three named |
| What is selectable | `lib/master.js:78` `MASTER_ENABLED_ACCESS_LEVELS` | `['read-only']` only |
| Server refusal | `server.js:805` | `PATCH` rejects `suggest`/`write` with "not available yet" |
| The modal radios | `public/api-helper.js:1579` | renders all three, two `disabled` |
| The enforcement badge | `public/api-helper.js:1629` | `structural` / `instructional`, **modal only** |
| The bar toggle | `public/api-helper.js:2057` | dim, `aria-disabled`, reason in `TC_MASTER_PENDING.access` |
| The guard | `lib/master.js:413` `buildMasterGuardScript(home)` | takes **only** the home path — read-only is *generated into* it |
| When the guard is written | `lib/master.js:812` | inside the launch path, `if (enforcement === 'structural')` |
| Enforcement tier | `lib/master.js:176` | `engineId === 'claude' ? 'structural' : 'instructional'` |
| The instructional boundary | `lib/master.js:59` `MASTER_BASELINE_RULES[0]` | prose: **"Read-only. Use only GET endpoints…"** |

Two facts fall out of that table and they shape every chunk:

1. **The guard has no notion of level.** It is a template string with `HOME` interpolated and
   "deny unless under `memory/`" written into its body. There is nothing to flip.
2. **On a non-Claude Master the boundary is a sentence in a file.** `MASTER_BASELINE_RULES[0]` is
   the whole enforcement, it is regenerated on `ensure`, and it currently says "Read-only" no matter
   what the level says. So on those engines "immediate" is not achievable and the prose is *already*
   the thing that would be wrong at `write`.

## What the operator ratified (2026-08-17) — do not re-litigate

Both rulings are on #755 in full; the load-bearing parts:

- **The toggle lives on the bar** and takes effect **immediately**, meaning the Master's next tool
  call. The gear keeps the complete access-level control with its enforcement badge — the bar is the
  fast path, not a second source of truth.
- **The guard reads the level at invocation, from a plain file in the master home** — not from TC's
  config. The guard must not need to know TC's internals to stay correct, and a format change in the
  store must not be able to break the boundary.
- **Every failure path degrades to read-only.** Missing, malformed, unreadable → deny. This is the
  acceptance criterion, not a nicety: *a level-aware guard that fails open is strictly worse than the
  baked-in one it replaces.*
- **`write` means the guard permits, not that the guard is absent.** Skipping guard generation at
  `write` would leave a stale read-only guard from a previous ensure silently in force.
- **The toggle works on every engine, and the bar shows the enforcement tier.** Read-only is
  *already* unenforced on non-Claude engines today; a locked `READ` there would imply a binding
  boundary that does not exist. Settable everywhere; the badge is what keeps it truthful.
- **The toggle is GLOBAL — there is exactly one Master.** `MASTER_TMUX_SESSION` is a single reserved
  tmux session and every drawer attaches the same iframe. The warning must say so, the toggle paints
  from server state rather than optimistically from the click, and other open bars must not sit on a
  stale value.

## The one thing #755's title promises that this plan does not deliver

#755 is titled *"…enable suggest/write, **server-enforced**"* and its original body argued for a
scoped TangleClaw API token so the boundary would be identical on every engine. The 2026-08-17
rulings moved the mechanism to a level-aware `PreToolUse` guard, which is Claude-only by
construction.

**These are not the same deliverable, and this plan delivers the second one.** What ships here is
the **file-write** tier: what the Master may write, where, structurally on Claude and instructionally
elsewhere, with the difference visible. What does **not** ship is a scoped Master token, a
fleet-mutation route, or any capability for the Master to act on TangleClaw's API. The Master still
has no checkout and no mutation surface; `write` means "may edit files under its home and anywhere
else it can reach", not "may drive the fleet".

That is a coherent and useful tier — it is the difference between a Master that can and cannot keep
working notes, drafts, and cross-project scratch files. But the plan says it plainly so the issue is
not closed on a promise it did not keep. **`[DECISION: #755 ships the file-write tier only; the
scoped-API-token half is separated into its own issue | the rulings chose a guard mechanism that
cannot carry API authority, and shipping both under one issue would let the smaller half close the
larger | RULED by the operator 2026-08-17 — decision B]`**

---

## Decisions — RULED 2026-08-17 by the operator

All three were put as recommendations and all three were taken. They are settled; do not
re-litigate them mid-build.

| | Decision | Ruling |
|---|---|---|
| **A** | Does `suggest` ship here, via fall-through-to-ask? | **Yes — ships in chunk 1** |
| **B** | Does #755 close on the file-write tier? | **Yes — close it; file the token half separately** |
| **C** | The dashboard's stale-toggle window | **Re-fetch before flip only — no new timer** |

**A. `suggest` ships in chunk 1, via fall-through-to-ask.**

There is a mapping that makes all three tiers real for almost nothing. The `PreToolUse` hook has
three outcomes, not two: emit a `deny` decision, or **exit 0 with no decision at all**, which falls
through to the harness permission rules and asks the operator in the Master's own terminal. So:

| Tier | Guard behavior | What the operator sees |
|---|---|---|
| `read-only` | explicit `deny` outside `memory/` | refused, with the reason |
| `suggest` | fall through — no decision | Claude Code asks before each write |
| `write` | allow | writes proceed |

That is precisely #755's stated meaning of `suggest` ("may propose mutations; each requires explicit
operator confirmation before executing") and it costs one branch in the guard. The alternative —
build `suggest` later as a TC-side proposal queue with a confirm UI — is a materially bigger feature
and would leave the modal's middle radio disabled through another release.

**The caveat that must ship with it:** `suggest` collapses into `write` when the Master's launch mode
is `bypassPermissions`, because nothing is ever asked. The modal already warns on
`write` + `bypassPermissions` (`api-helper.js:1656`); that warning must extend to `suggest`, or the
tier silently means something else than it says.

**B. #755 closes on this plan.** The API-authority half — a scoped Master token and a fleet-mutation
route — becomes its own issue against the Master Control milestone: different mechanism, different
risk profile, and a dependency on the Switchboard relay (#333). Keeping one issue open across both
invites the smaller half to close the larger. **File that issue before chunk 3's PR**, so #755's
closing PR can point at its successor rather than leaving the deferral in a plan file only.

**C. No new timer on the dashboard.** The session page rides its existing poll tick; the dashboard
repaints on open, on ensure, and on the re-fetch before every flip. The dangerous half of staleness
is closed (no flip can act on a value another surface changed); the cosmetic half — a panel left open
showing a stale segment until something touches it — is accepted, deliberately, rather than paid for
with a timer on a page that has none.

---

## Chunks

Dependency-ordered. Chunk 1 is the keystone: it is a thin vertical slice through the enforcement
path — store the level, read it in the guard, prove a flip binds without a restart — before any UI
is built on top of it.

### Chunk 1 — the level store and the level-aware guard

**Type:** `code` · **Critic mode:** `final` (override forward — the guard is a security boundary and
its coherence must hold before two surfaces are built against it) · **Visual change:** no

The whole enforcement change, with no UI. Deliverables:

- **A level file in the master home**, written on every `ensure` and on every `PATCH /api/config`
  that changes `master.accessLevel`. Persisted-format decision below.
- **`buildMasterGuardScript` becomes level-aware** — it takes the level *file path*, not the level,
  and reads it at invocation. Three outcomes per the table in decision A.
- **Guard written unconditionally when `enforcement === 'structural'`**, at every level. Today's
  `if` at `lib/master.js:812` already does this; the change is that the *level* now decides behavior,
  never the presence of the guard.
- **`MASTER_ENABLED_ACCESS_LEVELS` widens** and `server.js:805`'s refusal goes.
- **The status payload keeps reporting the truth** — `enforcement` stays derived from the engine, and
  gains whatever the bar needs to say "this tier is not structurally backed here".

**The persisted format is a lock-in decision** (planning guide: reversal cost, not LOC). Its
consumers and their questions, enumerated before any field is designed:

| Consumer | Question it must answer | Now or later |
|---|---|---|
| The guard script | "may I permit this write?" | now |
| `getMasterStatus` | "what is stored?" — already answered by config | now (as a cross-check) |
| A future proposal queue | "what did the operator intend when they set it?" | later |

Two questions, one of them already answered elsewhere. **Recommendation: a single trimmed token on
one line, plain text, no JSON.** JSON buys a field the consumers do not have a question for, and it
adds a parse failure mode to a file whose entire job is to be readable by a guard that must never
crash. The guard trims, compares against the three known tokens, and treats *anything else* —
including an empty file, extra lines, or a token it does not recognize — as `read-only`.

**Done when:**
0. Read `/prawduct:methodology building`.
1. The level file is written on ensure and on the PATCH path, and its content round-trips.
2. `buildMasterGuardScript` reads the file per invocation; unit tests cover all three tiers.
3. **Fail-closed proven by mutation, not by assertion.** For each of: file absent · empty · garbage
   token · unreadable (mode `0o000`) · path is a directory — the guard denies. Each test must be
   watched go **red** against a guard that returns allow on that path, per the standing rule that a
   guard returning GREEN before it is mutated asserted nothing.
4. A live flip binds with no restart: set `write`, have the Master edit outside `memory/`, succeed;
   set `read-only`, repeat, denied. Verified against a real Master session, not a fixture.
5. `PATCH` accepts all three levels and still rejects an unknown one.
6. Suite green; JSDoc on every new function.

**Watch for:** the guard resolves `HOME` today via `path.resolve(HOME, target)`; the level file path
must be interpolated the same way (absolute, JSON-stringified into the template) and must sit
**outside** `memory/` — a level file the Master can edit is a level file the Master can raise.

### Chunk 2 — the instructional half: the identity tells the truth about the level

**Type:** `code` · **Critic mode:** `chunk` · **Visual change:** no

`MASTER_BASELINE_RULES[0]` says **"Read-only. Use only GET endpoints…"** unconditionally. At `write`
that sentence is false, and on a non-Claude Master it is the *only* boundary there is — so this is
not cosmetic, it is the enforcement on four of five engines.

The complication: the rules are stored as editable `session_rules` rows seeded from the baseline,
with version history and a Restore-defaults path. The level cannot simply rewrite rows the operator
may have edited.

**Approach:** keep the editable rows as the operator's own boundary text, and render the *level* as a
separate, non-editable line in the generated identity — derived at generation time from the current
level, alongside the rules rather than inside them. `buildMasterClaudeMd` gains the level; the
baseline rule's first sentence loses its unconditional "Read-only" framing and keeps its substance
(what the Master does *not* do to projects) so an operator who edited it does not lose their edit.

**Also here:** on non-Claude engines the identity is regenerated on `ensure`, **not per tool call** —
so the toggle is *not* immediate there. The status payload must carry that distinction so chunk 3's
bar can say it rather than implying otherwise.

**Done when:**
1. The generated identity states the current level at all three tiers, verified by reading the
   generated file at each.
2. An operator-edited baseline rule survives a level change.
3. Restore-defaults still recovers the shipped boundary.
4. The payload distinguishes "binds on the next tool call" from "binds on the next ensure".
5. Suite green.

### Chunk 3 — the bar toggle, the badge, and the global warning

**Type:** `code` · **Critic mode:** `cumulative-final` · **Visual change:** **yes** — queue an entry
in `.prawduct/operator-verification.md`

- **The toggle goes live** in `tcMasterControlBarMarkup` / `tcCreateMasterControlBar`, replacing the
  `master-bar-pending` treatment and removing `TC_MASTER_PENDING.access`. Per the standing trap
  recorded at the call site: the moment a control gets a backend it becomes the extracted shared
  component, never a copy that happens to share a stylesheet.
- **It paints from server state, never optimistically from the click** — PATCH, then paint from the
  response. A failed PATCH leaves the toggle where it was and surfaces the error in the bar's
  existing `master-bar-error` region.
- **Re-fetch status before every flip**, so a flip can never act on a value another surface changed.
- **The warning fires on the way IN only** (READ→WRITE), never on the way back — returning to
  read-only is always the safe direction and warning there trains the operator to click through. Its
  text must say the change is **global**: §2b's current blast-radius wording ("modify files across
  every project it can reach") is right about reach and silent about scope.
- **The bar inherits the enforcement badge** — the `master-enforcement-badge` vocabulary exists in
  the modal and shows nothing on the bar, so a Gemini Master and a Claude Master look identical
  there. That gap predates this issue and closes here, where it is nearly free.
- **The modal's tier hints stop saying "Not available yet"** (`api-helper.js:1576-1577`) and the
  `write` + `bypassPermissions` warning extends to `suggest` per decision A.

**Cross-surface freshness — the mechanism, and what it does not cover.** The ratification says other
open bars must repaint "on their next poll". Verified: **the dashboard has no poll** —
`refreshMasterDot()` is one-shot and its comment cites the no-UI-timers rule. The session page *does*
have a visibility-aware `setTimeout` chain that Medusa already rides ("same cadence — no new timer",
`session.js:1970`). So:

- **Session page:** the Master level rides the existing `pollTick`. No new timer, matching the
  Medusa precedent exactly.
- **Dashboard panel:** repaints on open, on ensure, and on the re-fetch before any flip.
- **Residual, accepted under decision C:** a dashboard panel left open while another surface flips
  shows a stale segment until something touches it. It cannot act on that stale value — the pre-flip
  re-fetch closes the dangerous half — and the cosmetic half is not worth a timer on a page that has
  none. *The ui.js comment at `3444` cites "the no-UI-timers rule" as the reason for no polling; that
  is a mis-citation — the norm (#98/#268) governs timer-driven **lifecycle** (auto-dismiss, revert,
  redirect, blind reload), and `reconnect-policy.js:101` records a poll explicitly as **inside** the
  norm. Correct the comment; do not treat it as a constraint it never was.*

**Done when:**
1. Flip to WRITE from a session drawer, Master edits outside `memory/`, succeeds — no restart.
2. Flip back to READ, repeat — denied, no restart.
3. Corrupt or delete the level file — denied. **Verified, not assumed.**
4. Flip in one session's bar; a second session's bar shows the new level on its next poll tick.
5. A non-Claude Master never renders as structurally enforced, at **either** surface.
6. The warning fires on READ→WRITE only, and names the global scope.
7. Keyboard-operable and screen-reader-labelled; the segment control meets the ≥44px target or
   inherits chunk 3-of-#768's collapse rule if that lands first.
8. `/prawduct:critic cumulative`, then `/prawduct:pr`.

### Not in this plan

- **Scoped Master API token / fleet mutations** — decision B; a separate issue.
- **Mobile density, touch targets, and the bar's collapse rule** — carried into **#768 chunk 3**,
  not here. This plan must not absorb it; the two would enlarge each other's diff mid-review.
- **Consolidating the settings-modal CSS into `shared-controls.css`** — also #768 chunk 3 (R-7).
- **Master Kill / Upload / Medusa / Wrap** — the bar's other dim controls, each its own backend.

---

## Standing constraints for whoever builds this

- **`public/` is served live off the primary checkout.** Build in a git worktree
  (`git worktree add .claude/worktrees/755-access-level <branch>`), symlink every `.prawduct/*` entry
  except the tracked `change-log.md`, plus `.tangleclaw/plans`. **Keep the primary on `main`.**
- **Never bump `CACHE_NAME` in `public/sw.js`.** A new shared module goes in `NETWORK_FIRST_PATHS`
  *and* `STATIC_ASSETS`; a bump tears down every browser's worker and, behind the auth gate, produced
  the repeating credential prompt in #710.
- **Mutate every guard, and check the fixture reaches the subject first.** A guard that passes before
  it is mutated asserted nothing — three vacuous guards shipped in one train on 2026-08-15, and a
  `python3 -c` without `&&` will happily report a pass it never applied.
- **A finding-fix is new code.** Mutate every fix from the Critic round too.
- **Set `active_build_plan`** in `.prawduct/project-state.yaml` to this plan before the first commit
  — the pointer is empty today, so the Stop-hook Critic gate is unarmed.
- **No npm dependencies**, CommonJS, `'use strict'`, JSDoc on every function, tests in `node:test`.

## Status

- [ ] Chunk 1 — level store + level-aware guard
- [ ] Chunk 2 — level-aware identity
- [ ] Chunk 3 — bar toggle, badge, global warning

## Related

#755 (this) · #768 + `.tangleclaw/plans/768-master-control-bar.md` §2b (the bar; amend its warning
wording with the global-scope sentence when chunk 3 lands) · #756 (shipped) · #829 (tracking) ·
#333 (Switchboard relay — the transport the API-authority half would need) ·
`docs/adr/0008-project-master-session-model.md` (the read-only boundary and the G2 deferral)
