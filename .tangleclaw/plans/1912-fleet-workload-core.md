---
title: "Fleet Workload Visibility, Phase A: launch-bound workload receipts, a bounded activity observer, and the composed fleet read (#1912)"
status: BUILT AND REVIEWED — A1–A4 done; boundary review rev-20260926T205009Z-fe3d8f70 resolved (verify ...6b3a3264, ...b240055a), 0 blocking; PR next (not merged by this session)
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-26 (message 806b9000), after Architect ruling FWV-A18 approved ADR 0020 at 533b1386
contract: docs/adr/0020-session-workload-receipts.md (PR #1916). This plan implements it and does not restate it; where the two differ, the ADR wins and this plan is corrected.
controlling_train_plan: /Users/jasonvaughan/Documents/Projects/TangleClaw-ProjectManager/.tangleclaw/plans/train-fleet-workload-visibility.md (the PM's; Phase A = A.1–A.3, A.4 typed dispatch excluded)
issues: [1912]
scope: 1912-fleet-workload
branch: feat/1912-fleet-workload
partition: serial. Each chunk consumes the previous one's module, A1's store and route through A4's views
critic_mode: chunk per chunk, cumulative at the boundary before the PR
---

# Fleet Workload Visibility, Phase A (#1912)

**Requirements Confidence: High.** The contract is ADR 0020, accepted by the Architect as FWV-A18 after the FWV-A17 revisions. The PM's train plan fixes the scope (A.1–A.3, with A.4 typed dispatch excluded). The ADR ratifies the one judgment-dependent set of numbers, the expiry windows and the observer budget, and the observer budget is measured on this host (p95 29 ms per capture).

One branch, one PR, four chunks. It is not merged by this session (Pilot Envelope).
Out of scope: typed assignment-dispatch and dispatch supersession (ADR §4, a named dependency not
authorized by FWV-A18); Phase B (#1877); Phase C (#1889); Project Master workload (composes UNKNOWN).

## Chunk A1: receipts and the write surface (ADR §1–§3)

- `lib/store.js`:
  - Schema v50 adds `workload_receipts` (append-only, `UNIQUE (launch_id, seq)`, CHECK-constrained enums), using a shared DDL function for fresh installs and the migration, plus a postcondition check.
  - `store.workloadReceipts`: `append` allocates `seq` inside a `BEGIN IMMEDIATE` insert transaction (with one retry); `latestForLaunch` and `listForLaunch`; A3 adds `appendNarrowing` and `activeNarrowing`.
- `lib/shared-docs-access.js`: `resolveAccess` returns `sessionId` and `launchId` for a project caller.
- `lib/workload.js`: body validation (schema `tc.workload/1`, refusal of unknown and server-owned keys, consistency rules, bounds), server stamping (ids, `assignment_id` from the open control assignment bound to the launch, `received_at`, `source`), and a per-lane rate limit.
- `POST /api/tc/workload` and `GET /api/tc/workload` (the caller's own lane).
- `tc workload set` and `tc workload show`.

**Done when** tests prove:
- Only a launch-verified project caller writes, and operator, Master, unbound, invalid and cross-project callers are refused.
- Every server-owned key and every unknown key is refused.
- Each consistency rule and bound refuses.
- `seq` is unique and increasing under concurrent writes.
- `assignment_id` is stamped only when an open control assignment is bound to this launch.
- The migration postcondition passes on a fresh store and on a v49 store.

## Chunk A2: the bounded activity observer (ADR §5)

**Carried in from the A1 review (they ride this chunk's commit):**
- **R-2:** a two-process test that calls `store.workloadReceipts.append` against one database, plus the retry-once on `SQLITE_BUSY` or a `UNIQUE` collision (ADR §2).
- **R-3:** a `bindingRefusal` test for every non-project kind including `master`, plus a route test with a master-role claim.
- **R-5:** a receipt dated in the future (the clock stepped back) must not lock the lane out.
- **R-6:** restore `controlApi`'s JSDoc.

**Measured capture latency (2026-09-26, this host).** 20 `captureAsync` calls against this session's own pane: p50 21 ms, p95 29 ms, max 30 ms, with load average 9 to 13 and 8 tmux sessions. A 3 s tick budget therefore covers about 100 captures at worst-observed latency, and the ADR's 1 s timeout per capture has about 30× headroom. The budget stands as ratified.

**[DECISION] Captures are asynchronous.** `lib/tmux.js` runs through `execSync`, and the server's event loop would block for the whole capture. With a 3 s tick budget, that is up to 3 s of stalled server every 10 s. The observer uses `execFile` with the same 1 s timeout per capture instead, and checks the session exists before `display-message` (which otherwise answers for the attached client). The ADR's limits are unchanged; only the blocking is removed.

`lib/activity-observer.js` reuses `_assessActivity`/`_composerEmpty` from `lib/medusa-wake.js`:
- 10 s tick, serial captures, 1 s per-capture timeout, 3 s per-tick budget, round-robin.
- Engines with a wake profile only.
- An in-memory cache, and strict at-rest over two observations.
- `observedAt` plus 30 s freshness, after which an observation reads as `unknown`.
- Started and stopped with the server.
- Capture latency measured on this host and recorded in the plan.

**Done when** tests prove the budget (a slow capture never overruns a tick), round-robin (no session starves), strict at-rest (composer text, one observation or agents running each deny `at-rest`), stale-to-`unknown`, and that nothing reads mail.

## Chunk A3: composition, supersession, overrides and the fleet read (ADR §4, §6, §7, §8)

**Carried in from the A2 review (they ride this chunk's commit):**
- **R-2:** the observer maps `not-at-rest` (a missing idle marker: a dialog, a menu, a resting Codex pane) to `NOT_AT_REST`, not `BUSY`. The ADR defines `busy` as a turn in flight or agents running.
- **R-3:** each capture's timeout is `min(CAPTURE_TIMEOUT_MS, remaining tick budget)`, so a tick cannot overrun 3 s. A test asserts the timeout the capture receives.
- **R-4:** deterministic tests of the append retry (fail once, fail twice, non-retryable) and of the route's 503 `WORKLOAD_BUSY`.
- **R-6:** CHANGELOG says the observer covers tmux sessions whose engine has a wake profile.

**Supersession sources (read at chunk start):**
- **Wrap:** `wrapRunRegistry.get(project)` keeps the last run's `sessionId` and `startedAt`, finished or not. `wrapSentinel.isWrapRequested(project)` is a pending request with no timestamp.
  - A receipt is stale when this session's wrap started after it, or while a request is pending.
  - Both live in memory, so a server restart forgets a cancelled wrap and its receipt can read current again. That is bounded by expiry, and is a known limit.
- **Control:** `control_events.created_at` is second-precision UTC. An event in the same second as a receipt counts as after it (fail closed). The kinds are hold, release, stop, rebind and close, on the receipt's assignment and on the lane's current open assignment.

- `lib/workload-compose.js`: the pure base composition (rules 1–11) and monotone operator narrowing.
- Supersession: current-receipt checks against control events and wrap start/request, plus expiry.
- Operator narrowing: store, route, operator-only.
- `GET /api/tc/sessions` gains `engine`, `workload` and `composed`. `tc sessions` renders them, and still runs no synchronous capture.
- `GET /api/tc/workload` and `tc workload show` also carry the lane's `composed` verdict (ADR §1; A1 review R-4).
- A transcript-parsing guard test.

**Done when:**
- The six #1912 acceptance cases pass as tests.
- There is one test per composition rule, including STOPPED/HELD, Master UNKNOWN, expiry and the narrowing limits.
- The route is proven to make no tmux call.

**Project Master lanes (A3 review R-4/R-6/R-13).** The Master is not a row in `sessions`, so the fleet read never reaches composition rule 2 in production. The rule stays, unit-tested, so that a future Master row composes `UNKNOWN` (`unsupported-master-lane`) rather than anything else. A4 adds no Master view: Master workload is out of scope (FWV-A18).

**[DECISION] A29 text safety (2026-09-26).** The Architect rejected the merge until the one-line text check also refuses C1 controls, Unicode bidi controls and U+2028/U+2029. One predicate, `isSafeText` in `lib/workload.js`, applies it to summary, waitDetail, task ids, branch and the narrowing reason (23c26e03). Characters A29 does not name, such as zero-width U+200B/U+2060/U+FEFF, U+00AD and the tag characters, still pass; whether to refuse them is put to the Architect, not decided here. ADR 0020 §3 still reads "no control characters"; amending it is the Architect's call.

**[DECISION] A24 UI freeze (2026-09-26 21:12Z).** The Architect froze dashboard and Master fleet-view UI. The PM (Medusa message c9e2213a) directed that all UI be removed from #1921, so the pure backend and CLI portion can merge. A4's dashboard badge, Workload detail row, landing fetch, CSS and their test were removed. What A4 keeps is the guidance line, the capability, and docs that describe the CLI and API only. The dashboard view waits for the revised boundary, tracked as #1923.

## Chunk A4: guidance and docs (ADR §9–§10); the dashboard view was deferred under A24 (#1923)

**Carried in from the A3 verify pass (they ride this chunk's commit):**
- **O-1:** move the `ACTIVITY_REASONS` block in `lib/medusa-wake.js` so `_FLEET_RE`'s explanatory comment sits directly on `_FLEET_RE` again.
- **O-2:** retitle the R-2 test to "a stopped project reads STOPPED …", and add the case of an assignment with no bound launch.

**Before the PR:** sync `main`, which now carries ADR 0020 through #1916. Then `prawduct-hook backlog sync --repo Jason-Vaughan/TangleClaw`, the full suite with recorded evidence, and the cumulative review.

- ~~The dashboard/fleet view renders the same response.~~ Deferred under A24 (#1923); the UI is held on `origin/held/ui-freeze-1912-dashboard-a3` (51c8b2dd).
- The injected operational guide and `tc capabilities` gain `tc workload set` and when to emit it.
- User guide, FEATURES and CHANGELOG `### Added`.

**Done when** (the view clause was deferred under A24, #1923) the guidance names the verb and the emission points, the docs are updated, the cumulative review is clean, and the PR is open.

## Merge order

PR #1916 (ADR 0020) merges before this branch's PR. This branch syncs `main` before the boundary review, so the ADR it cites is on it (A1 review R-7).

## Status

- [x] Chunk A1: receipts and write surface
- [x] Chunk A2: activity observer
- [x] Chunk A3: composition, supersession, overrides, fleet read
- [x] Chunk A4: guidance, docs; cumulative review + PR (not merged by this session). The dashboard part was deferred under A24 (#1923)
