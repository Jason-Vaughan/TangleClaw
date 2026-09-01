# Master awareness floor (#1141) — the Master joins the awareness system

**Branch:** `feat/1141-master-awareness` (worktree `.claude/worktrees/master-awareness`)
**Issue:** [#1141](https://github.com/Jason-Vaughan/TangleClaw/issues/1141)
**Size:** medium (one chunk; Critic cumulative before PR). Ships in v5.17.0.
**Requirements Confidence:** High — the gap is structural and read directly from
the code this session (`ensureMasterSession` passes only profile env; no store
session row; receipts unattributable); the PATH mechanism was probe-verified in
#1140. Medium assumption, resolved by decision below: how to attribute master
receipts (new `role` column, not workspace-id reuse).

## Problem

The Master pane has none of the ambient-awareness system: no env floor, no
`tc`, no ledger presence — its carrier (the generated identity file) can break
with nothing turning red anywhere. See #1141.

## Design decisions

1. **Attribution = a new nullable `role` column on `awareness_receipts`**
   (additive migration v32→v33). NOT workspace-id reuse: a medusa-disabled
   Master has no workspace id, and the attribution key must not couple to
   messaging opt-in. Project receipts leave it NULL.
2. **Env floor in `ensureMasterSession`**: `TANGLECLAW_API` (same omit-never-
   fake rule as sessions), `TANGLECLAW_ROLE=master`, `TANGLECLAW_WORKSPACE_ID`
   when minted, and the launch command wrapped with `sessions._withPathFloor`
   (reversing the #1140 exclusion — its comment updates in the same commit).
   NO `TANGLECLAW_PROJECT_ID` — the Master has no project and must not claim one.
3. **`bin/tc` sends the role**: `x-tangleclaw-role` header + `role` query param
   (same dual pattern as project id). Dependency-free, version-skew-safe.
4. **`/api/tc/whoami` answers the master identity** when `role=master` and no
   project resolved: "You are the TangleClaw Project Master", master-shaped
   capability roster (Read API incl. `/api/awareness`; switchboard per master
   medusa settings, honest absence otherwise), receipt recorded with
   `role='master'`. `renderWhoami` in `lib/tc-verbs.js` renders it.
   The dispatcher receipt recorder carries role too (both writers, one family).
5. **`masterAwareness()` composed at read time** (lib/store.js + lib/master.js
   for tmux/session-start facts), same vocabulary:
   - `not-running` — no live master pane (nothing launched, nothing to be aware).
   - `confirmed` — ≥1 role=master receipt since the current pane's start time.
   - `sent` — pane live, identity file present on disk (carrier written,
     nothing demonstrated).
   - `unaware` — pane live, identity file MISSING (the severed-carrier case).
6. **Surface**: `/api/awareness` gains a top-level `master` entry with
   `{state, basis, receiptCount, lastVerb, lastReceiptAt, startedAt}`.
   The states legend already serves the vocabulary. Consumers updated:
   api-contract §, FEATURES.md, master guide line (it already points the
   Master at `/api/awareness` — it will now see itself).

## Out of scope

- Dashboard UI badge for the master (no master card exists; the API entry is
  the queryable surface — UI treatment can follow if wanted).
- A store `sessions` row for the master (would ripple through every session
  consumer; the read-time composition needs none).
- Wrap/rules delivery ledger for the master (it has no rules tier).

## Tests (red-first where the defect is expressible)

- master launch env: captured `createSession` env carries API/ROLE/floor-wrapped
  command; no PROJECT_ID. (Red on main.)
- whoami with role=master: master identity + receipt with role='master'.
  (Red on main.)
- masterAwareness: all four states, incl. receipt-since-start scoping (an old
  receipt from a previous master run does not confirm the current one).
- /api/awareness carries the master entry. (Red on main.)
- Regression: project receipts keep role NULL; sessionAwareness untouched.

**Done when:** suite green; mutations red (env floor dropped, role recording
dropped, master entry dropped, since-start scoping neutered); CHANGELOG
`### Added`; docs synced; Critic cumulative + resolutions; PR `Fixes #1141`;
post-merge restart + live VRF (master pane relaunch → `tc whoami` answers the
master identity and `/api/awareness` shows master `confirmed`).

## Status

- [x] Chunk 01 — env floor + role receipts + whoami identity + masterAwareness + surface
- [ ] Critic (cumulative) + resolutions
- [ ] PR (Fixes #1141), merge, restart, live VRF
- [ ] Release v5.17.0 (version bump, CHANGELOG promote, README pins per #1137 pattern)

## Context

Chunk 01 built; suite green; since-scoping mutation red. Next: Critic
cumulative → PR → merge → restart → live VRF → release v5.17.0.
