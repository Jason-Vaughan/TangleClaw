---
title: "Fleet Workload Visibility, Phase A: launch-bound workload receipts, a bounded activity observer, and the composed fleet read (#1912)"
status: IN PROGRESS: Chunk A1 building
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

One branch, one PR, four chunks. It is not merged by this session (Pilot Envelope).
Out of scope: typed assignment-dispatch and dispatch supersession (ADR §4, a named dependency not
authorized by FWV-A18); Phase B (#1877); Phase C (#1889); Project Master workload (composes UNKNOWN).

## Chunk A1: receipts and the write surface (ADR §1–§3)

- `lib/store.js`:
  - Schema v50 adds `workload_receipts` (append-only, `UNIQUE (launch_id, seq)`, CHECK-constrained enums), using a shared DDL function for fresh installs and the migration, plus a postcondition check.
  - `store.workloadReceipts`: `record` allocates `seq` inside a `BEGIN IMMEDIATE` insert transaction; `current(launchId)` and `history`.
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

`lib/activity-observer.js` reuses `_assessActivity`/`_composerEmpty` from `lib/medusa-wake.js`:
- 10 s tick, serial captures, 1 s per-capture timeout, 3 s per-tick budget, round-robin.
- Engines with a wake profile only.
- An in-memory cache, and strict at-rest over two observations.
- `observedAt` plus 30 s freshness, after which an observation reads as `unknown`.
- Started and stopped with the server.
- Capture latency measured on this host and recorded in the plan.

**Done when** tests prove the budget (a slow capture never overruns a tick), round-robin (no session starves), strict at-rest (composer text, one observation or agents running each deny `at-rest`), stale-to-`unknown`, and that nothing reads mail.

## Chunk A3: composition, supersession, overrides and the fleet read (ADR §4, §6, §7, §8)

- `lib/workload-compose.js`: the pure base composition (rules 1–11) and monotone operator narrowing.
- Supersession: current-receipt checks against control events and wrap start/request, plus expiry.
- Operator narrowing: store, route, operator-only.
- `GET /api/tc/sessions` gains `engine`, `workload` and `composed`. `tc sessions` renders them, and still runs no synchronous capture.
- A transcript-parsing guard test.

**Done when:**
- The six #1912 acceptance cases pass as tests.
- There is one test per composition rule, including STOPPED/HELD, Master UNKNOWN, expiry and the narrowing limits.
- The route is proven to make no tmux call.

## Chunk A4: the dashboard view, guidance and docs (ADR §9–§10)

- The dashboard/fleet view renders the same response.
- The injected operational guide and `tc capabilities` gain `tc workload set` and when to emit it.
- User guide, FEATURES and CHANGELOG `### Added`.

**Done when** the view renders every availability value from a composed response (test), the guidance names the verb and the emission points, the docs are updated, the cumulative review is clean, and the PR is open.

## Status

- [ ] Chunk A1: receipts and write surface
- [ ] Chunk A2: activity observer
- [ ] Chunk A3: composition, supersession, overrides, fleet read
- [ ] Chunk A4: dashboard, guidance, docs; cumulative review + PR (not merged by this session)
