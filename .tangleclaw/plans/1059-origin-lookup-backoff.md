# #1059 — Back off the update-checker's failed origin lookup

*Dual-Builder Pilot, Lane 1. Branch `fix/1059-pilot-update-checker`. Dispatched by the PM on 2026-09-24.*

## Status

- [x] Plan written; architectural items sent to the Architect
- [x] Architect has ruled on A1–A3 (all approved 2026-09-24; see Rulings)
- [x] Build: back-off + clock seam + tests + CHANGELOG (`### Fixed`)
- [x] Verify: focused tests + full suite
- [x] Critic (cumulative, 2026-09-24: 0 blocking, 0 warnings, 2 notes on this plan, both fixed)
- [ ] Draft PR opened — **STOP here** (pilot boundary)
- [ ] After #1311 merges and the PM says go: rebase, rerun focused + full suite + Critic on the combined target

**Pilot envelope (set by the Architect; these restrictions are IN FORCE):** no merging any PR, no pulling/updating the live checkout,
no restarting the live service, no live check on the main instance, no tag/publish/release, no deploy.

## Problem

`_getReleasesUrlBase` (`lib/update-checker.js`) memoizes a real answer (a GitHub URL base, or `null`
for "not a GitHub remote") but deliberately never memoizes a *failure*. Caching a failure would
remove the release-notes link for the life of the process. The cost: once `git remote get-url origin`
fails, every measurement that finds a tag pays a fresh synchronous `execSync` of up to 2s inside
`_buildStatus`. Both check forms reach it: the async form's completion callback and
`update-applier`'s sync pre-flight. A degraded install stalls the event loop again on every check. The
staleness floors cap how often that happens (5 min automatic, **10 s manual**), so it is not urgent,
but an operator pressing refresh can still trigger a 2s stall every 10 seconds.

## Confidence check

1. **Problem:** after the origin lookup fails once, each later check blocks the event loop for up to 2s.
2. **Success:** after a failure, the lookup does not spawn again until the back-off window has passed.
   After the window it retries once. If git works again, the link comes back and is memoized as it is
   today. A real answer is still spawned once per process.
3. **Out of scope:** making the origin lookup asynchronous. Changing the memoization of real answers.
   `ls-remote` timeouts. Any config setting. The HTTP API is unchanged: `releaseUrl` is already `null`
   when the lookup fails.

Requirements confidence: **High**. The issue names the fix direction; only the window and the seam
are left open (A1, A3).

## Design

- New module state `_releasesUrlBaseRetryAt` (ms epoch, or `0` = no back-off). When a read throws,
  `_getReleasesUrlBase` sets it to `now + ORIGIN_LOOKUP_BACKOFF_MS`. While `now < _releasesUrlBaseRetryAt`
  it returns `null` without spawning. When the lookup answers, it memoizes the answer as it does today
  (the retry timestamp stops mattering). `_reset()` clears the timestamp, following the module's rule
  that `_reset` clears every latch.
- New `_internal.now: () => performance.now()` clock seam (monotonic; see Implementation calls). Only the back-off reads it.
- `ORIGIN_LOOKUP_BACKOFF_MS` is exported next to the other `*_MS` constants so tests can step past the window.
- Logging is unchanged: an attempt that actually runs and fails still logs at `debug`. A skipped
  attempt logs nothing, because nothing new was learned.

### Tests (`test/update-checker.test.js`, block "the origin lookup is memoized, but only when it answered")

The existing test "does NOT memoize a failure" asserts that two back-to-back calls spawn **twice**. That
is exactly the behavior #1059 changes. The test is not weakened. Its contract is "a failure is not
cached forever and the link comes back", and the new tests keep that contract while adding the window:

- a failure spawns once, and a second call inside the window does **not** spawn (returns `null`);
- after the window passes (clock seam), the next call spawns again;
- recovery after the window: git works again → the link comes back and is then memoized (one spawn,
  none after);
- a failure after the window re-arms the back-off (a multi-step test: fail → skip → retry-fail → skip);
- `_reset()` clears the back-off (the next call spawns immediately);
- both check forms honor it: a `checkForUpdateAsync` measurement with a failing origin followed by a
  second measurement inside the window gives one `gitRemote` spawn.

## Architectural decisions (sent to the Architect)

**A1 — Back-off shape and length.** *Recommend:* a fixed **5 minute** window, as a constant (no setting).
It matches `AUTO_REFRESH_MIN_AGE_MS`, so an unattended install makes at most one extra spawn per
automatic cadence, and a manual refresh storm (10 s floor) is limited to one 2s stall per 5 minutes.
The link comes back at most 5 minutes after git recovers.
*Rejected:* exponential back-off with a cap (more state for a failure that is already bounded at 2s);
60 s (`MIN_CHECK_INTERVAL_MS`: manual refreshes could still stall every minute); a config setting
(a new operator-facing knob for an internal performance guard); never retry (what #1059 rules out).

**A2 — Scope: failure-only, and shared by both check forms.** *Recommend:* the back-off applies only
to the thrown-read case. `null` ("not a GitHub remote") and a URL stay memoized for the process, as
today. It sits in `_getReleasesUrlBase`, so the sync pre-flight (`update-applier`) and the async
completion path share one window.
*Rejected:* a separate window per check form (two latches for one fact, which the module's own
`_versionUnreadable` reasoning rejects); backing off `null` too (it is a real answer, not a failure).

**A3 — Test seam: an `_internal.now` clock.** *Recommend:* add a `now` clock to the module's
existing `_internal` seam object, the convention `lib/stranded-check.js` and `lib/checkout-state.js`
already use.
*Rejected:* `node:test` `mock.timers` with `Date` (global mocking that leaks across a shared test file,
and nothing else in the suite uses it for this); a `now` parameter on `_getReleasesUrlBase` (widens a
signature that `_buildStatus` calls for a test-only need).

## Architect rulings (2026-09-24)

These apply only to the internal timing scope stated above. Re-escalate if the implementation changes
the API or persisted contract, the scope, or the recovery bound.

- **A1 APPROVED, with a condition:** `ORIGIN_LOOKUP_BACKOFF_MS` is its own constant, fixed at 5 minutes.
  It equals `AUTO_REFRESH_MIN_AGE_MS` in value but is not defined in terms of it.
- **A2 APPROVED:** one failure-only window in `_getReleasesUrlBase`, shared by both check forms. Real
  answers stay memoized for the process, and there are no duplicate retry latches.
- **A3 APPROVED:** `_internal.now` as the narrow module-local seam, with no global timer coupling.

## Implementation calls (not architectural)

- The seam returns `performance.now()` (monotonic), not `Date.now()`. It measures only an in-process
  interval and is never persisted. A backwards wall-clock step under `Date.now()` could stretch the
  window past the 5-minute recovery bound. The Architect was told this as an FYI within A3's scope.

- The timestamp is a number rather than a `Date`, so the comparison is exact.
- The skipped path does not log (see Design).
- CHANGELOG entry under `[Unreleased]` → `### Fixed` (dispatch-specified).
