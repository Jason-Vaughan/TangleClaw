# Train 12.5 — Chunk A: The settings modal stops lying

**Train:** 12.5 "Settings & Modals Cleanup" (TangleClaw-Roadmap master roadmap, Blessed & Assigned)
**Chunk:** A of 3 · **Branch:** `feat/train-12.5-chunk-a` · **Base:** `5ed3585`
**Critic mode:** cumulative (single chunk on this branch — the cumulative serves as its review)

## Why these three together

Train 12.5 has six cars. Two of them (#764 per-engine tabs, #626 creation fields) carry unresolved
design questions in their own text and are not buildable yet — they are Chunk C, which opens with a
discovery step. #596 is its own surface with its own test net (Chunk B).

The remaining cars share a property: each one *shrinks or de-lies* the existing settings surface.
That ordering matters, because #764 will restructure the settings modal into per-engine tabs —
deleting and relocating before restructuring makes that later change smaller, not larger.

## Requirements Confidence

**High** for #1181 and #758 — both have a located mechanism and an existing in-repo pattern to
follow. **The premise of #1227 is disproven** (see below); it needs an operator ruling before any
deletion, and nothing else in this chunk depends on it.

## Cars

### A1 · #1181 — Move the session chime toggle into the live session banner

**Problem.** The per-session chime toggle exists only inside the Session Settings modal
(`public/session.html:240`, `#chimeToggle`). Turning the chime on before stepping away costs three
interactions: open the gear modal, flip the toggle, close the modal. There is a *separate* global
mute in the landing page's Global Settings (`public/ui.js:2147`, `gsChimeMuted`) — that one stays
where it is; it is a fleet-wide preference, not a per-session one.

**Also found while reading, and in scope as a bug fix.** `updateChimeIndicator()`
(`public/session.js:2792`) only ever *adds* the `active` class:

```js
function updateChimeIndicator() {
  const btn = document.getElementById('cmdBtn');
  if (sessionState.chimeEnabled) {
    btn.classList.add('active');
  }
}
```

Two defects in five lines. It never removes the class, so switching the chime off leaves the
indicator lit until reload. And it paints onto `#cmdBtn`, whose `active` state *also* means "the
command bar is open" — two unrelated meanings on one pixel. Moving the toggle to its own banner
control retires this function rather than fixing it in place.

**Done when**
- A dedicated chime control sits in `.banner-actions` (`public/session.html`), reachable in one tap.
- Its pressed state reflects `sessionState.chimeEnabled` in **both** directions.
- `#cmdBtn` no longer carries chime state; `updateChimeIndicator` is gone, not merely corrected.
- The modal's chime row is removed — moved, not duplicated (the issue says "moved up into").
- The control carries `aria-pressed` and an `aria-label` that names the current state.
- Toggling persists through `saveSetting('chime', …)` exactly as the modal path did, and the
  existing chime-on-idle behavior at `public/session.js:1908` is untouched.
- Global mute (`gsChimeMuted`) still wins over the per-session toggle — verified, not assumed.

### A2 · #758 — Warn when a launch-time-only setting changes under a live session

**Problem.** A setting resolved at launch is stored immediately and never reaches the running
process. The modal accepts the input, reports success, and changes nothing observable — the worst
shape a settings control can have.

**Scope decision (recorded).** The issue was filed about the *model*, but the project settings modal
has no model field — the model arrives via the orchestration profile (#357), set elsewhere. The
issue's own Recommendation section anticipates this and asks for the **class**, driven off a single
declared list, rather than a bespoke check. That is what this car builds. The launch-time-only keys
reachable from this modal:

| key | what a running session does about it | advice |
|---|---|---|
| `engine` | the live process IS the old engine | relaunch |
| `silentPrime` | the session was primed the old way | relaunch |
| `defaultLaunchMode` | read fresh every launch (`lib/sessions.js:350`) — nothing stale | next launch |
| `showLaunchModePicker` | read by the launch flow at click time — nothing stale | next launch |

The split in the third column arrived with the Critic (R-7) and is the difference between
correcting an expectation and asking someone to kill live work for nothing.

Two of these already carry a static hint. The hint is shown unconditionally, so it says the same
thing whether or not a session is live — which is exactly why it does not land. The gap is the
*live-session* case: say it actively, and say what to do about it.

**Resolution on the issue's open question — advisory, not blocking.** The save is not destructive
and nothing is lost; a modal would add friction to a correct action. The eyes-open guard stays
blocking because it removes a safety warning from a future launch; this merely corrects an
expectation. Recorded here rather than decided silently during the build.

**Done when**
- One declared list of launch-time-only keys is the single source; no per-key bespoke checks.
- The notice appears only when the project has a live session **and** the save actually changes at
  least one key in that list from its stored value — a save of tags alone stays silent.
- The copy states both halves: the change is saved, and what the running session does about it —
  a relaunch ONLY for the settings a relaunch actually reconciles.
- Nothing reverts and nothing blocks: the PATCH proceeds exactly as today.
- A project with **no** live session behaves byte-identically to today. No new friction.
- Engine-agnostic: "settings apply at next launch" is how TangleClaw launches every engine, so
  the notice is never conditioned on Claude.
- A test fails if a key is added to the launch-time-only list with no notice path — the list is
  derived, not restated in the test (this repo's fourth copied-roster instance is #1231; do not
  create a fifth).

### A3 · #1227 — Remove the dead "Audit" button from Project Settings — **BLOCKED, premise disproven**

The issue states the Audit button "was placed as a placeholder but never wired up." Verified against
the code on `5ed3585`; that is not the case.

- There is **no** Audit button in the Project Settings modal. Its body (`public/ui.js:1143`) renders
  Name, Engine, Tags, launch mode, silent prime, feature index, project map, version bump, version
  file path, Medusa, Medusa wake, and the project rules section. No Audit control.
- The only Audit button in the product is the **dashboard** toggle (`public/index.html:75`), and it
  is wired end to end: listener at `public/ui.js:3965` → `toggleAudit()` (`:3689`) →
  `loadAuditSummaries()` (`:3704`) → `GET /api/audit/:project/summary` (`server.js:7072`) →
  `renderAuditPanel()` renders a populated table. It is one of 13 live `/api/audit/*` routes.

Deleting it would remove a working feature. **Needs an operator ruling** — most likely readings:
the button was already removed by earlier work, or the report meant a different control. Nothing
else in this chunk depends on the answer, so A1 and A2 proceed regardless.

## Out of scope

- Restructuring the settings modal (that is #764, Chunk C).
- The global chime mute in Global Settings — fleet-wide, deliberately left alone.
- Any launch-time-only setting not reachable from the project settings modal (the orchestration
  profile's model binding, #357) — the declared list is extensible; widening it is not this chunk.
- Deleting any Audit surface, pending the A3 ruling.

## Status

- [x] A1 · #1181 chime toggle in the banner
- [x] A2 · #758 launch-time-only advisory
- [x] A3 · #1227 — CLOSED not-planned: premise disproven, the button stays. Real defect = #1236
- [x] Cumulative Critic, all 26 findings dispositioned (15 fixed, 11 accepted)
- [x] verify-resolutions: 0 blocking / 0 warnings / 0 notes; all 10 warnings confirmed fixed
- [x] Suite green on the reviewed tree, evidence ingested from JUnit
- [x] CHANGELOG entry
- [x] PR #1235 merged (`7f6bdbe`), pulled into the live install, server restarted 18:28
- [~] Operator verification — the chime bell is confirmed toggling BOTH ways on a phone, which is
      #1181's actual defect. Still unseen by a human: whether the chime SOUNDS when armed, and
      #758's amber banner (needs an engine change on a live session). See
      `.prawduct/operator-verification.md` → "PARTIAL RESULT".

### What A2 became, and why it differs from the plan above

The plan sketched a client-side check in `doSaveSettings`. Reading the code found the
`warnings` channel #1148 already built — `updateProject` → PATCH response →
`renderSettingsWarnings` → a dismissible banner — so the warning is produced **server-side**
instead. That covers every caller rather than one modal, keeps the copy engine-agnostic without
a branch, and is unit-testable with no DOM.

It also exposed a second half the plan did not anticipate: the **session page** changes `engine`
— a launch-time-only key — from the one place a live session is guaranteed, and was discarding
the PATCH response entirely. That page now renders the warning too, and the renderer both pages
use moved to `tcRenderSettingsWarnings` in `public/api-helper.js` rather than being copied.

### What the Critic changed — the copy was telling its own lie

The review's sharpest finding (R-7) was that the warning over-claimed, and it was right. Only
`engine` and `silentPrime` leave a running session genuinely diverged. `defaultLaunchMode` and
`showLaunchModePicker` are read **fresh at the start of every launch** (`lib/sessions.js:350`),
so a running session never held a copy of them to go stale — telling the operator to "close and
relaunch to apply" asked them to kill live work for nothing. A car whose whole premise is
stopping the settings modal from lying had shipped a different lie.

The roster stays one list; each member now carries a `divergence` (`running` / `next-launch`)
and each group gets its own sentence, because one sentence covering both could only be true of
one of them. Both tails are asserted by iterating the roster.

Nine other findings landed in the same pass: the session page's REJECTED save was the only
silent outcome left (it now shows `api.lastError`); the banner had been hand-copied onto the
session page wearing `.engine-error-banner`, i.e. danger-red for a save that SUCCEEDED, so its
markup is now single-sourced in `tcSettingsWarningsMarkup` with its styles in the stylesheet
BOTH pages load; the chime control mounted after four awaits and an early `return`, so it read
"off" on a session that would chime and never bound at all on the not-found path; a third
`warnings` consumer (`setActivePlan`) reads the array as a FAILURE and now says why that is
sound; and the docs that described the moved chime toggle and the moved renderer were repointed.

### Guards, and what each was mutated against

Every guard below was checked by breaking the code and watching it go red — a guard that has
never failed is a guard nobody has measured.

| Mutation | Guard that caught it |
|---|---|
| `classList.toggle('active', on)` → `if (on) add(...)` (the shipped defect) | "disarming REMOVES the class" |
| bind-once latch removed | "binds once — a second mount cannot stack a handler" |
| live-session check dropped from the warning | "stays silent with no running session" |
| value comparison → presence-only | "a key sent at its EXISTING value is silent" (×2) |
| roster entry naming a field no config has | "every reader resolves against a real project" |

The last one is worth recording: it **passed** against the first version of the guard, because
the fixture was a synthetic object carrying only today's three keys. A reader naming a dead field
returned `undefined` and every assertion still held, while in production it would have reported
that setting as changed on *every save*. Re-pointing the fixture at a real project row and its
real on-disk config is what made the guard measure the shape it will actually see.

## Context

All three cars touch `public/`, and the primary checkout is the live install — this work is done in
the worktree at `.claude/worktrees/train-12.5-chunk-a`, with the ignored `.prawduct/` state
symlinked back to the primary so governance sees one source of truth.

Baseline suite at `5ed3585`: green. (No count recorded — the evidence store holds pass/fail per
tree and nothing parses a number in prose, so one written here could only drift.)
