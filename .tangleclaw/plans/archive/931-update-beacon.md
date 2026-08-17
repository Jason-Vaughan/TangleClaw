---
artifact: build-plan
scope: update-beacon-931
depends_on:
  - artifact: interaction-design
  - artifact: architecture
governed_by:
  - artifact: security-model
    dispositions:
      - "secure by default → inapplicable; no auth, ingress, bind, or credential surface is touched. The update apply route and its guards are unchanged — only which pixels start it."
last_validated: 2026-08-15
---

# Build Plan — one update beacon on the serpent, both pages (#931)

Replaces two inconsistent update surfaces — the dashboard's `#updatePill` and the
session banner's `#updateBadge` — with one beacon anchored on the logo, identical
on both pages: a toast that pops once and fades, and a red dot that persists until
the update is applied.

## Confidence Check

**What problem are we solving?** An operator lives on the session page, where the
only update signal is a badge so subtle the product's own operator did not know it
existed — and whose single un-confirmed tap fires agent instructions. The dashboard
pill is the real control and is invisible from where the work happens. Field
installs learn that a release exists through this surface (the v5.1.0 experience,
2026-08-15).

**What does success look like?** On either page, when an update is detected: a
toast pops from the logo naming the version with one action, fades on its own, and
leaves a red dot on the logo that survives the fade and re-opens the toast on
click; "Update now" runs the *same* guarded apply-and-restart flow from both pages;
and there is exactly one code path deciding what an available update looks like.

**What's out of scope?** The update *check* — `#version`'s tap-to-check control and
its unknown/failed markers (#716/#744) are untouched. The apply route and every
guard behind it (#711 dirty-tree, provisioning report) are untouched. Idea 02's
menu from the mockup is not built.

## Requirements Confidence

**Level: High.** The design is operator-chosen from an interactive mockup rather
than inferred, the mockup's timings and markup were read rather than recalled
(`i1Trigger`: 3000 ms → `fading`, 3450 ms → removed; `.reddot` 11 px, `top/right:
-3px`, 2 px page-coloured border), and every flow it drives already exists and has
tests.

Four decisions the issue left to build time, and one departure from it:

**[DECISION: one shared `public/update-beacon.js`, not a per-page copy | the issue's
own justification is "one system, one meaning" — two implementations of
pop-fade-dot-reopen would be two systems again within a release, which is exactly
how the pill and the badge diverged | the alternative, copying ~120 lines into
`session.js`, is cheaper today and is the failure this issue exists to undo]**

**[DECISION: the apply-and-restart flow moves into the shared module too, with its
page-specific parts injected (in-flight latch, action-label setter, confirm text) |
the session page must run "the existing guarded flow", and the only way for it to
be *the same* flow is for there to be one of it; a second copy would drift from the
#711 dirty-tree and provisioning handling on its first fix | the alternative,
leaving it in `landing.js` and calling it from `session.js`, cannot work — a
classic-script `async function` in `landing.js` is not loaded on the session page
at all]**

**[DECISION: the dashboard keeps sharing ONE `restartInFlight` latch between the
#235 stale-server restart and the update apply | that coupling is why the two paths
cannot fire concurrently today, and moving the code must not quietly unbind it |
the module therefore takes `getInFlight`/`setInFlight` accessors rather than owning
a latch, so the dashboard passes `state.restartInFlight` and the session page
passes its own]**

**[AMENDED DURING CHUNK 01: `postServerRestart` and `pollServerBackAndReload` go to
`api-helper.js` as `tcCreateRestartFlow`, NOT into the beacon | wiring the dashboard
surfaced a caller the plan had not counted — `triggerServerRestart`, the #235
stale-server restart, drives both of them and is not the beacon. Putting them in the
beacon would have made the restart button reach into "the update beacon" for its
plumbing, and a reader looking for the restart flow would not find it | `api-helper.js`
is already the file both pages load and already describes itself as the single source
of truth for their shared helpers, so the beacon now takes `restart` as a dep]**

**[DECISION: both surfaces state the SAME restart duration | the issue's sketch
said "~5 s" for the session and the dashboard says "~3 seconds"; it is one
operation, and two numbers for it on two surfaces re-creates in prose the exact
inconsistency this issue removes in pixels | the session's confirm adds what is
genuinely different there — the terminal blips and reconnects on its own — without
inventing a second measurement of the same restart]** *Flagged to the operator: a
deliberate, minor departure from the issue text.*

**Explicitly descoped, not dropped:** the pill's per-version dismiss
(`tc_updateDismissed_<version>` in `localStorage`) does **not** carry over. The dot
IS the quiet resting state that dismiss existed to provide, and a permanently
dismissible beacon restores the invisibility the issue exists to fix. Stale keys
from previous versions are left in place — inert, and reading them would be the
only thing that could resurrect the behavior.

### The no-UI-timers rule, and why a fade is inside it

`feedback_no_ui_timers` / #98 / #268 forbid timer-driven UI *lifecycle*. The issue
ratifies the fade explicitly, and the boundary this build holds is mechanical: a
timer may only change **opacity and visibility of a notification whose state is
preserved elsewhere**. No timer may navigate, dismiss durable state, or invoke an
action. The dot is that elsewhere — it is set at the same moment the toast pops and
is cleared only by the update being applied. A guard asserts this rather than
trusting it (see Verification Strategy).

## Status

- [x] Chunk 01: The shared beacon, and the dashboard on it
- [x] Chunk 02: The session page on the same beacon
- [x] Chunk 03: A session keeps asking (added 2026-08-15, operator-delegated)

Context: built 2026-08-15 on `feat/931-update-beacon`, worktree
`.claude/worktrees/931-beacon` — `public/` in the primary clone is served live to
the operator, so branch work cannot happen there. Baseline before the first commit:
6080 tests, 0 failures (`node --test test/*.test.js`). The invariant is zero
failures at every commit on this branch; re-derive the count rather than trusting
this one.

`Critic mode:` cumulative-final — two chunks, one issue, one PR.

**Review record.** `cumulative` (rev-…T174745Z) returned 1 blocking, 10 warnings,
12 notes; all fixed or dispositioned in one commit. `verify-resolutions`
(rev-…T180550Z) verified all 11 blocking/warning findings fixed with 0 new
findings, and demoted 8 observations; three were closed in a follow-up commit,
five accepted with reasons in that commit's message. **The blocking finding is
worth carrying forward**: `render` decided "is this a real answer?" on
`checkedAt` alone, missing `checkOk: false` — the state
`lib/update-checker.js#_buildStatus` emits when a check RAN and could not
measure. An offline install therefore read as "up to date" and the dot came down
for an update that was genuinely available. The correct principle was already
written in that guard's own comment; enumerating the producer's states is what
was missing, not the reasoning.

## Scaffolding

### Project Initialization

Existing repo. Node 22+, `node:test` built in. No `package.json` at the root, and
none is added — the zero-npm-dependency norm holds.

### Dependencies

None added. The beacon is one classic `<script>` on both pages, same as
`api-helper.js`.

### Build & Test Configuration

`node --test test/*.test.js` from the repo root.

### Scaffold Verification

Worktree at `.claude/worktrees/931-beacon`, with every gitignored `.prawduct/*`
entry symlinked back to the primary **by explicit name** (a glob misses
`.handoff-notes.md` and `.session-reflected` when they do not yet exist there),
plus `.tangleclaw/plans`.

`public/sw.js` **is** touched, and the distinction matters: the two new assets join
`NETWORK_FIRST_PATHS`, and `CACHE_NAME` is **not** bumped. The plan originally said
sw.js would not be touched at all, which was wrong in the safe direction — a new
asset that is neither precached nor network-first is served cache-first forever
after its first fetch, so the next change to the beacon would be invisible behind
an active worker (the #271 pattern, on the one surface that announces releases).
Bumping the generation is the move that is genuinely forbidden here: it tears down
and reinstalls every registered worker, which behind the auth gate locked the
operator out of Chrome on 2026-07-28 (#710).

## Project Structure

```
public/update-beacon.js          # NEW — tcCreateUpdateBeacon factory: render, pop,
                                 #       fade, dot, re-open, and the apply flow
public/landing.js                # dashboard wiring; pill render + apply flow leave
public/session.js                # session wiring; badge render leaves
public/index.html                # .dash-logo gains a beacon anchor; #updatePill goes
public/session.html              # .banner-logo gains a beacon anchor; #updateBadge goes
public/beacon.css                # NEW — the beacon's styles, ONE file linked by
                                 #       both pages (their stylesheets are separate,
                                 #       and a copy in each is the same drift in CSS)
public/style.css                 # .update-pill* rules go
public/session.css               # .update-badge rules go
public/sw.js                     # the two new assets join NETWORK_FIRST_PATHS
                                 #       (no CACHE_NAME bump — #710)
test/update-beacon.test.js       # NEW — the module's behavior, lift-and-run
test/update-beacon-pages.test.js # NEW — both pages reach it, and agree
test/ub-self-update-action.test.js  # was ub-self-update-pill; reduced to what
                                 #       cannot be executed, plus the cross-file
                                 #       "one flow" invariant
test/update-release-link.test.js # was update-pill-link; frontend half now executed
test/landing-dirty-discard-flow.test.js  # REMOVED — its three cases are reproduced
                                 #       verbatim at module level in the new suite
```

## Build Chunks

### Chunk 01: The shared beacon, and the dashboard on it

- **Description:** Create `public/update-beacon.js` exposing
  `tcCreateUpdateBeacon(deps)`; move the apply-and-restart flow into it verbatim
  but parameterized; put the dashboard on it and delete the pill.
- **Deliverables:**
  - `tcCreateUpdateBeacon({doc, anchorId, api, apiMutate, restart, getInFlight,
    setInFlight, confirmText, secondaryAction})` returns `{render, reopen, apply}`.
    (The plan first listed an `applied()`; nothing calls it — a successful update
    restarts the server and the next `render` carries `updateAvailable: false`,
    which is the same clear by a path that already exists. An unused method
    invented here would be a requirement nobody asked for.)
    `render` is called with an `/api/update-status` payload and decides everything:
    no `checkedAt` → leave the surface alone (an unmeasured check is not "no
    update", the #716 rule); `updateAvailable` false → clear dot and toast;
    available → set the dot, and pop the toast **once per detected version per page
    load**.
  - The toast is `role="status"`, the dot is a real `<button>` with an accessible
    name naming the version. The fade is CSS; the two timers only add/remove
    classes on the toast, never on the dot.
  - `applyUpdateAndRestart`, `pollServerBackAndReload` and `postServerRestart` move
    into the module with their comments and behavior intact — the #711 dirty-tree
    confirm, the named-file refusal, the provisioning report before the restart,
    the honest no-restart-mechanism degradation, the no-blind-reload abort.
  - `landing.js` constructs the beacon with `state.restartInFlight` as its latch
    and keeps `triggerServerRestart` (#235) sharing that same latch.
  - `#updatePill`, `.update-pill*` CSS and the dismiss key are removed. `#version`,
    `renderVersionCheckHint` and the check markers are untouched.
- **Acceptance criteria** (each with the mutation that must drive it red):
  - A payload with `updateAvailable` pops the toast AND sets the dot. *Mutation:*
    set the dot only after the fade → the pop-with-dot assertion fails.
  - **After the fade, the dot is still set and the toast is gone.** *Mutation:*
    clear the dot on the fade timer → red. This is the criterion the design turns
    on: the fade must lose nothing.
  - Clicking the dot re-opens the toast, and the re-opened toast carries a ✕ the
    first pop does not. *Mutation:* render the same toast both times → red.
  - A second `render` with the same version does not re-pop; a render with a *new*
    version does. *Mutation:* drop the seen-version guard → the poll re-pops every
    60 s.
  - `updateAvailable: false` clears the dot; `checkedAt: null` leaves it alone.
    *Mutation:* treat a null-`checkedAt` payload as "no update" → the dot vanishes
    during the server's first-check window (the #716 regression).
  - "Update now" reaches the real apply route through the real `api` chain, with a
    confirm first — and the #711 all-TC-dirty 409 still produces the discard
    confirm and re-applies with `{discardDirty: true}`. *Mutation:* any of the
    moved branches dropped in transit → the migrated
    `landing-dirty-discard-flow` suite fails.
  - No timer argument in the module reaches anything but a class toggle on the
    toast element. *Mutation:* make a timer call the apply flow or `location` →
    red.
- **Deliberately not done:** no animation on the dot (the mockup's ring/glow
  belong to ideas the operator did not choose).

### Chunk 02: The session page on the same beacon

- **Description:** Wire the banner logo to the same module; retire `#updateBadge`;
  keep the #730 agent path as a secondary link in the *re-opened* toast only.
- **Deliverables:**
  - `session.js` constructs the beacon against `.banner-logo` with its own
    in-flight latch and a confirm that says the terminal blips and reconnects.
  - The re-opened toast renders "Update now · Ask the agent"; the first pop stays
    single-action. `buildUpdatePrompt` and `injectUpdatePrompt` are unchanged and
    keep their #730 guard wording — only what is clickable changes.
  - `#updateBadge`, its `.update-badge` CSS and `loadUpdateStatus`'s badge branch
    are removed; the session's update-status read now feeds `render`.
- **Acceptance criteria** (each with its mutation):
  - The session page pops and dots identically to the dashboard, from the same
    module — asserted by driving *both* pages' wiring through one test and
    comparing the resulting DOM state. *Mutation:* give either page its own
    render → red.
  - The agent link appears only in the re-opened toast, never in the first pop.
    *Mutation:* render it in both → red.
  - Tapping the agent link injects the prompt built by the unchanged
    `buildUpdatePrompt`; tapping "Update now" does not. *Mutation:* swap the two
    handlers → red.
  - The session's "Update now" hits the same route sequence as the dashboard's.
    *Mutation:* point either at a different route → red.
- **Deliberately not done:** the session page does not gain the `#version`
  tap-to-check control; checking stays a dashboard gesture.

### Chunk 03: A session keeps asking (operator-delegated, 2026-08-15)

- **Why it exists:** review and scrub both left one gap the plan had scoped out
  by omission rather than by decision — the session page read update status once,
  at page load. Sessions here run for days, so the beacon never fired for the
  population the issue names. The operator delegated the call; building it was
  the answer, because a surface that only works for someone who happens to
  reload is the original bug wearing the fix's clothes.
- **Deliverables:** `UPDATE_CHECK_INTERVAL_MS` (the dashboard's 300000, asserted
  equal rather than restated), `updateCheckDue(lastAt, now)`, and `pollTick()`
  riding the EXISTING session-status chain — not a second timer, so it inherits
  the visibility skip and the burst protection that chain exists for. The read
  stays a cached GET; a re-measurement here would mean a `git ls-remote` per open
  session every five minutes.
- **Acceptance criteria** (each with its mutation):
  - Due → reads; not due → does not. *Mutation:* drop the gate, or the read.
  - **Re-arms**: a read stamps the clock, so the next is one interval later, not
    every tick forever. *Mutation:* skip the stamp — the multi-hop failure a
    single "does it fire?" assertion cannot see.
  - The first tick after load does not re-read (init already did).
  - The cadence EQUALS the dashboard's, read from `landing.js`. *Mutation:*
    diverge — two answers to "how often do we ask" is the pill-and-badge
    divergence again, in timing.
  - `startPolling` drives `pollTick`. *Structural, and it says so:* which chain
    calls it cannot be executed, and a second chain would look correct in every
    behavioral test while losing both inherited properties.

## Verification Strategy

**Lift-and-run, not source pins.** The #928 R-1 lesson is on record: a source-pin
test proved a dirty-tree branch *existed* while `api()`'s null-on-409 made it
unreachable. Every behavioral criterion above runs the real module in a `vm`
sandbox against a minimal DOM stand-in, driven through the real
`tcCreateApi`/`tcCreateApiMutate` chain with `fetch` returning the shapes the
routes actually produce — the pattern already proven in
`test/landing-dirty-discard-flow.test.js`.

Timers are injected, not awaited: the sandbox's `setTimeout` records `(fn, ms)` and
the test fires them by hand. That makes "what happens after the fade" a direct
assertion instead of a 3.5 s sleep, and it makes the no-UI-timers guard mechanical
— the test can inspect exactly what every scheduled callback touches.

**Each guard is driven by its named mutation** — applied, watched go red, restored,
baseline re-confirmed green. The roster lives in the tests under
`THE MUTATION THIS CATCHES`; grep for that phrase rather than trusting a tally
here, which is a number that goes stale inside one review round.

Source pins survive only where behavior cannot be executed: the CSS rules and the
two pages' markup anchors. Those assert presence, and they say so.

## Artifacts To Update

- ~~`interaction-design.md`~~ — checked during chunk 02: it does not describe the
  update surface at all, so there was nothing to correct. Listed here in error.
- `docs/adr/0010-one-update-mechanism.md` — names "the dashboard pill" and "the
  session badge" as live surfaces. The DECISION is unchanged (and easier to hold
  now), so the ADR gains a supersession note rather than a rewrite of its history.
- `FEATURES.md` / `PROJECT-MAP.md` — a new `public/` module and two retired ids.
- `CHANGELOG.md` `[Unreleased]` → `### Changed` (an operator will absolutely notice
  next session: the pill and the badge are gone and a different thing appears).
- `.prawduct/artifacts/test-specs.md` if it names the pill's suites.

## Operator Verification

Visual change: **yes** — both pages' chrome changes. Queue in
`.prawduct/operator-verification.md` at chunk close: the operator is almost never
on this machine, so nobody in this session can see the result.
