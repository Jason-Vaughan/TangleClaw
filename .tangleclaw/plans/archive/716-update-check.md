---
scope: 716-update-check-on-demand
---

# Build Plan — update checks that happen when they matter

Parent requirement: **issue #716** ("Update notification isn't dependable"), gaps 1 and 2.
Read the issue first; this plan implements two of its five bullets and explicitly declines the rest.

## Problem (observable, measured on this box 2026-07-29)

The operator asked why no update pill appeared for a release published 37 minutes earlier. The
mechanism, with real timestamps:

| Time (UTC) | Event |
|---|---|
| `00:07:37` | Server started; `startChecker` arms a 60s initial delay |
| `00:08:37` | **First and only check ran.** Newest remote tag: `v4.36.0`. Correct at the time. |
| `00:46:06` | `v4.37.0` published |
| `04:08:37` | Next scheduled check (`DEFAULT_CHECK_INTERVAL_MS` = 4h) |

Live payload during that window:
`{"updateAvailable":false,"latestVersion":"4.36.0","checkedAt":"2026-07-29T00:08:37.667Z"}`

Two distinct defects, both confirmed by running the product:

1. **Nothing re-checks on the events that matter.** `GET /api/update-status` (`server.js:1527`) is
   `jsonResponse(res, 200, updateChecker.getCachedStatus())` — a **pure cache read**. It never calls
   `checkForUpdate()`. Meanwhile `public/landing.js:1431` runs `loop(loadUpdateStatus, 300000)`, so
   the dashboard re-asks every 5 minutes and faithfully re-reads the same frozen answer ~48 times
   before the cache can move once. The polling *looks* like checking and is not. There is no route,
   query param, or button anywhere that can force a check — `checkForUpdate()` is called only by the
   timer and internally by `update-applier.js:95`.

2. **A cold cache reports "up to date" without having looked.** Captured immediately after the
   restart in this session: `{"updateAvailable":false,"latestVersion":null,"checkedAt":null}`.
   `landing.js:533` correctly refuses to *clear* a pill on that payload, but when no pill is present
   the render is identical to a measured "you're current."

Net effect: the absence of a pill is unfalsifiable from the UI. The operator had no way to ask, and
the server had no reason to answer.

## Success

- Opening the dashboard, or returning to its tab, produces an update answer measured **within
  minutes**, not within four hours.
- The operator can **demand** a check and see its result, so "no pill" becomes verifiable rather than
  merely observed.
- A never-checked or failed state is visibly distinct from a measured "up to date."
- No dashboard interaction can stall the server or hammer `origin`.

## Requirements Confidence

**High.** Both defects were reproduced against the running product with timestamps rather than
inferred from code, and the parent requirement is written out on #716 rather than invented here.

**Medium** on the throttle floors (5 min automatic / 10 s manual). They are chosen to sit at the
existing client poll cadence and to make a double-tap harmless; no measurement says those are the
right numbers.

[ASSUMPTION: `git ls-remote` against GitHub costs ~0.5–1.5 s on a healthy network, so an automatic
refresh on tab-focus is affordable at a 5-minute floor. Vetoable — if it proves slower in the field
the floor rises; it does not change the design, because the call is moved off the event loop either
way.]

## Out of scope — declined deliberately, not overlooked

- **Fork-origin detection freeze** (#716 gap 3). A fork's tags stop at creation, so Elliot-class
  installs report up-to-date forever. Real, separately tracked on #711, and unfixable by re-checking
  more often — re-asking a source that cannot answer changes nothing.
- **Making apply→restart server-side / resumable.** Belongs with the applier, not the notifier.
- **Breaking the `GET /api/update-status` payload shape.** It has two consumers
  (`public/landing.js:523`, `public/session.js:579`) and neither may move.

  **One additive field is required, not optional.** Today the failure path and the
  no-tags-found path build the *same* object — `{updateAvailable:false, latestVersion:null,
  checkedAt:<time>}` — so a check that threw is indistinguishable from a check that succeeded and
  found nothing. Success criterion 3 ("a failed state is visibly distinct from a measured up to
  date") is unreachable without a signal, so the payload gains **`checkOk: boolean`**, false when
  the `ls-remote` failed. Additive: both existing consumers ignore unknown keys, and a client seeing
  `undefined` (older server) falls back to today's behavior.
- Shortening the 4h timer further — `#720` already took it 24h → 4h and that is sufficient as a floor
  once event-driven checks exist.

## Design

### Why the check must become non-blocking

`checkForUpdate()` uses `execSync` with a 15 s timeout. Today that only freezes the single-threaded
server once every 4 hours, which nobody notices. Making it **request-triggered without changing
that** would let any dashboard load block every other request — including the terminal
websockets — for up to 15 s on a flaky network. The operator reaches this box remotely over
Tailscale, so that is the worst possible thing to make interactive. The exec moves off the event loop.

To avoid two drifting implementations, the transport is the only thing that differs:

- `_buildStatus(currentVersion, lsRemoteOutput, checkedAt)` — **pure**, holds all parsing, semver
  comparison, and payload assembly. One place, shared.
- `checkForUpdate()` — unchanged synchronous public API. Timer and `update-applier` keep using it.
- `checkForUpdateAsync(cb)` — `execFile`-based, feeds the same `_buildStatus`.
- `refreshIfStale(maxAgeMs, cb)` — throttle + **single-flight**: returns the cache when `checkedAt`
  is younger than `maxAgeMs`; otherwise runs one async check and fans its result out to every caller
  waiting on it, so N tabs cannot become N `git ls-remote` calls.

Constants: `AUTO_REFRESH_MIN_AGE_MS = 5 * 60_000`, `MANUAL_REFRESH_MIN_AGE_MS = 10_000`. A manual tap
gets a tighter floor because a user who explicitly asks deserves a real answer; 10 s exists only so a
double-tap cannot hammer.

### Server

`POST /api/update/check` — new, additive. Body `{"manual": true|false}` selects the floor. Responds
with the same status shape as `GET`. POST because it has a side effect (a network call); `GET` stays
a cheap, side-effect-free cache read.

[SUPERSEDED — this originally added a `refreshed: boolean` so the client could distinguish a fresh
answer from a throttled one. It shipped, then came back out: no consumer was ever written for it,
and `checkedAt` (which does not move when the cache is reused) already carries the same fact.
Recorded rather than quietly deleted — "a field added for a consumer that never existed" is the
reusable lesson.]

### Client

- `loadUpdateStatus({ refresh })` — `POST /api/update/check` when refreshing, else the existing `GET`.
- **On initial load** and **on `visibilitychange` → visible**: refresh (automatic floor). This mirrors
  the established `public/sw-register.js` visibility-poll pattern the issue cites.
- **The 5-minute loop stays a plain `GET`.** Making it refresh would mean a `git ls-remote` every
  5 minutes forever, 288/day against `origin` versus 6 today — more aggressive than the problem
  warrants. Freshness comes from events; the 4h timer remains the backstop.
- **Header version becomes the manual control** (operator decision, 2026-07-29): `#version` becomes a
  real `<button>` — not a `role`-annotated span — so it is keyboard- and screen-reader-reachable.
  Tap → `checking…` → transient result (`up to date ✓` / the pill appears / `couldn't check`) →
  reverts to the version label. `title` carries "Checked Nm ago — tap to check now", which is what
  makes a cold state legible.
- No timer-driven page lifecycle beyond the existing poll: the transient label reverts on a timeout,
  which is a label swap, not a lifecycle action. (`feedback_no_ui_timers` rules out auto-dismiss,
  redirect, and close — not text restoration.)

## Tests

- `test/update-checker.test.js` — `_buildStatus` parity: sync and async paths yield identical payloads
  for identical `ls-remote` output; throttle serves cache inside the window and re-checks past it;
  a cold cache (`checkedAt: null`) refreshes immediately regardless of floor; single-flight coalesces
  concurrent callers into one exec; a failed exec yields a failed-check payload, never a false
  "up to date".
- `test/api-integration.test.js` — `POST /api/update/check` returns the same key set as the `GET`;
  a repeat request is throttled (identical `checkedAt`, since a re-measure would advance it);
  `GET /api/update-status` is unchanged.
- `test/version-visibility.test.js` — the existing client harness: tapping the version button issues
  a refresh; `checking…` and result states render and revert; a `checkedAt: null` payload renders as
  not-checked rather than up-to-date.

Each guard names the mutation it must catch — revert-verify the throttle and the single-flight, since
both are the kind of logic that passes vacuously if the fake clock never advances.

## Status

- [x] Chunk 1: non-blocking throttled check + `POST /api/update/check` + event-driven and manual
      client refresh

Built 2026-07-29. Full suite **5095/5096 pass, 0 fail** (1 pre-existing skip), up from a 5057/5058
baseline — **38 new tests**. Six mutations were **revert-verified**, each turning its own guard red:
removing the `_inFlight` queue, short-circuiting the staleness comparison, inverting the
`manual → floor` ternary, feeding `_buildStatus` the wrong output, memoizing a failed `origin` read,
and dropping the per-waiter `try/catch`.

**Three things this chunk delivered that the design above did not anticipate.** Recorded here so the
plan is not read as a complete description of what shipped:

1. **`checkOk`** — the failed path and the no-tags-found path built byte-identical payloads, so
   success criterion 3 was unreachable without a new field. Written back into "Out of scope" above
   at the time rather than absorbed silently.
2. **The header version freezes in a backgrounded tab.** Reported by the operator mid-build: a
   suspended tab read 4.36.0 against a server running 4.37.0, because browsers suspend timers and
   #744's version tracking is timer-only. Refocus now refreshes the running version as well,
   sequenced ahead of the measurement — refreshing only the update answer would have left the
   header contradicting the pill beside it.
3. **The tooltip does not exist on touch.** Success criterion 3 rode on `el.title` plus a `:hover`
   tint, neither of which a phone has — and the phone is this project's primary platform, so the
   criterion was not actually met on the device that matters. Never-checked and check-failed now
   render a visible marker, and the control gets a 44px tap target under `(pointer: coarse)`.

4. **`refreshed` shipped and was then removed.** The Design section specified it so the client could
   tell a fresh answer from a throttled one. It went in, and no consumer was ever written — the
   route comment claimed a capability the UI never used, while `checkedAt` already encoded the same
   fact. Removed rather than left as a field the contract owes but nothing reads. The lesson worth
   carrying is that it was specified, built, documented and tested before anyone asked what would
   consume it.

**Known gap, deliberately left:** a fork `origin` still freezes detection entirely (#711). Checking
more often cannot fix a source that structurally cannot answer, and this is the gap that governs the
one third-party install in the field.

Context: feature, medium (one new route, one new module surface, three client touch points).
Single chunk — the server and client halves are not independently useful, since a route nothing calls
and a button with nothing behind it each deliver zero of the success criteria.
