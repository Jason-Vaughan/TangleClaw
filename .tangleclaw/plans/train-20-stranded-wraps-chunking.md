# Train 20 — Stranded Wraps & Session Start: chunking

Status: PROPOSED 2026-09-15 by Builder, for the Coordinator to file as issues. Decisions are the ones the operator locked in the 2026-09-15 grill-me (relayed by the Coordinator). This is the program-level split; each chunk gets its own build plan when it starts.

## Locked decisions this plan implements

1. **Launch is blocked ONLY by local stranded rows.** A local stranded row is a `wrap.auto_pr` activity row with `stranded: true`, recorded after the upgrade. GitHub-derived findings (red CI, a branch with no PR) show a badge only. "Acknowledge and continue" is always offered.
2. **Master is exempt; the Steward is not.** The Master launches through `lib/master.js`, not `launchSession`, so today the exemption holds by construction. The gate's scope is still written as a role policy (`appliesTo(session)`) so later roles don't need a special case.
3. **Offline is recorded.** A failed GitHub check writes its own state (reason, timestamp). The next session shows "unknown, couldn't check at T", never old data presented as current.
4. **Grandfathered.** Stranded rows from before the upgrade show a badge but don't block. There is a cleanup path for them.
5. **Crashed/killed badge.** Shown when the last session ended `crashed`, or `killed` with uncommitted or unpushed work in the project's own checkout. It compares against the session's `launch_sha`/`launch_dirty` launch baseline, so it only flags work done during that session.
6. **Acknowledgement is per item**, keyed by (git remote, branch, head SHA). It clears itself when the item's state changes, and every acknowledgement is logged with who and when.
7. **Future-proofing only, no new schema.** Key records by session and repo (git remote), not project alone. Tag every fact with `scope: 'repo' | 'session'`. Steps switch on and off by role. The multi-role/group schema is deferred to a later train.

## Advisory

- **Cut from the cleanup path: deleting remote branches.** It is outward-facing and irreversible. Chunk 04 offers "open a PR" and "acknowledge". Branch deletion stays a manual `git push --delete` that the item explains, unless the operator explicitly wants it in.
- **Budget risk:** the startup hook's output is capped per hook, and the prime is already trimmed to the engine's `startupInjection.maxChars`. The stranded section must stay small: a count plus the top N items and a pointer to the API/dashboard, never a full list.
- **Two new persisted formats lock in:** the acknowledgement record and the GitHub check result. Each issue below lists the questions that data must answer, so the fields follow from what readers need rather than from how it's implemented.

## Found when checking the plan against the code (2026-09-16)

- **`wrap.auto_pr` rows carry `branch` but not the remote or the head SHA.** Acknowledgements are keyed
  on (remote, branch, headSha), so Chunk 01 starts recording both. Older rows can't carry them, which
  matches their being grandfathered. See `train-20-chunk-01.md` D1–D2.
- **`activity_log` keeps at most 500 rows per event type (#869).** This install has 62 `wrap.auto_pr` rows
  since August, so a stranded row would be evicted within months. Chunk 01 writes stranded wraps to
  their own rare event type (`wrap.stranded`). See `train-20-chunk-01.md` D3.
- **Only #868 exists as an issue.** The Coordinator is filing the other eight (requested 2026-09-16).

## Chunks

### Chunk 01 — Local stranded-wrap query + acknowledgement + prime section (thin vertical slice)

Proves data → API → session-start text before any UI or gating.

- **Issue #868 (existing, re-scoped): surface stranded wraps from local records.**
  - New module that reads `wrap.auto_pr` rows where `stranded: true` and returns items `{scope:'repo', remote, branch, headSha, recordedAt, sessionId, grandfathered, acknowledged}`.
  - "Grandfathered" is decided by a boundary recorded at upgrade (migration marker), not by the date in the row.
  - `GET` API route for a project's stranded items.
  - A prime section built as its own component (the same pattern as `sessionOwnership.primeSection`), with engine-neutral text, a small budget, and an honest "none" line. It must not depend on where in the prime it sits, so the proposed step-by-step launch (Train 21) can move it unchanged into its own startup step.
  - Acceptance: a row with stranded=true appears in the API and the prime; a grandfathered row shows up flagged; the prime section stays within budget with 50 items; tests use temp stores, never the live store.
- **NEW: `[feature] Acknowledge a stranded wrap — per-item, audited record`.**
  - `POST` acknowledge {remote, branch, headSha} → activity event `wrap.strand_ack` {remote, branch, headSha, by, at}.
  - The data must answer: is this item acknowledged at its CURRENT head SHA? Who acknowledged it and when? What was acknowledged for this repo over a date range?
  - Acceptance: acknowledging hides the item from "unacknowledged"; a new head SHA on the same branch brings it back; `by` comes from the signed-in user (or an honest null).

### Chunk 02 — Launch gate + new-wrap soft block + dashboard badge

Depends on 01. Touches `public/`, so it is built in a worktree. Visual change: yes.

- **NEW: `[feature] Block launch on unacknowledged local stranded wraps`.**
  - In `launchSession` (server-side, so `tc`/API launches are covered too): 409 `STRANDED_WRAPS` with the items. A retry that includes the acknowledged item keys writes the ack records and proceeds.
  - Grandfathered items never block.
  - Role policy `appliesTo(session)`: the Master is out of scope by construction; the test pins that the Steward (a regular project) IS gated.
  - Acceptance: API, `tc` and dashboard launches all get the 409; acknowledge-and-continue works in one round trip; a GitHub-only finding never blocks.
- **NEW: `[feature] Soft-block starting a new wrap while a stranded wrap is unresolved`.**
  - The wrap drawer shows the items and asks for explicit confirmation. No timers.
  - The same check is enforced on the wrap API route, not only in the UI.
- **NEW: `[feature] Stranded / session-health badge on the dashboard`.**
  - Facts scoped to the repo go on the project header. Facts scoped to one session go on the session card (reserved for chunk 04).
  - Acceptance: operator verification on a real remote browser (Tailscale MagicDNS URL, not localhost).

### Chunk 03 — GitHub check, offline state, auto-clear

Depends on 01. Can run in parallel with 02; the only shared file is the API route module.

- **NEW: `[feature] Check stranded wraps against GitHub after launch (red CI, no PR, auto-clear)`.**
  - Runs asynchronously after launch and never delays the pane.
  - Open `wrap/*` PRs are checked with the existing `lib/wrap-pr-status.js` (`merged|pending|blocked|unknown`); `blocked` → red-CI badge.
  - Branches on origin with no PR → badge.
  - Merged PR, deleted branch or green CI → the item clears.
  - Results are cached.
  - Acceptance: tests fake `gh`/`git` failures; merged or deleted items leave the list; GitHub findings are never blocking.
- **NEW: `[feature] Record "GitHub unreachable" as its own state`.**
  - Activity event `wrap.strand_check` {ok, reason, at, remote}.
  - The data must answer: when was the last successful check? Why did the latest check fail? Is what's displayed current or old?
  - The prime and the badge show "unknown — couldn't check at T (reason)".

### Chunk 04 — Crashed/killed badge + grandfathered cleanup path

Depends on 01 and 02 (badge surface).

- **NEW: `[feature] Flag a crashed or killed session that left work behind`.**
  - The last session is `crashed`, or `killed` and the project's own checkout has changes that were NOT in `launch_dirty`, or commits ahead of upstream since `launch_sha`.
  - Scope: `session`. Other worktrees are ignored. The text says the work "may be from another session".
  - Deliberately killed sessions with a clean tree show nothing.
- **NEW: `[feature] Cleanup path for grandfathered stranded wraps`.**
  - A list view with per-item actions: open a PR for the branch (`gh pr create`, with confirmation), or acknowledge.
  - Branch deletion is explained, not automated (see Advisory).
  - Acceptance: every action is confirmed and audited; a failed `gh` call reports honestly and nothing changes.

## Partition

Serial for chunks 01, 02 and 04. Chunk 03 can be delegated in parallel with 02 in its own worktree once 01 has merged. Decide at the start of chunk 02.

## Docs & bookkeeping (every chunk)

CHANGELOG `[Unreleased]` under `### Added`, FEATURES.md, the API reference for the new routes and the 409 contract, and a Critic review per chunk.
