# Fix ambient-awareness defects: no-rules scored as red (#1139) + tc stripped from PATH (#1140)

**Branch:** `fix/1139-1140-awareness` (worktree `.claude/worktrees/fix-awareness`)
**Issues:** [#1139](https://github.com/Jason-Vaughan/TangleClaw/issues/1139), [#1140](https://github.com/Jason-Vaughan/TangleClaw/issues/1140)
**Size:** medium (two small bugfix chunks; Critic before merge)
**Requirements Confidence:** High — both defects reproduced live before design
(DateDealer 903 red on a fresh v5.16.0 launch; pane process PATH inspected);
the one Medium assumption (which shell layer strips the prepend) was resolved
by probe before implementation. Skipped-stays-red ratified by the standing
acceptance test.

## Problem

23 of 33 active projects show the permanent red ⚠ unaware badge, all for the same
non-fault: zero active session rules. Both escape routes from red are closed:

1. **#1139** — `sessionAwareness()` (lib/store.js) recognizes only
   `delivered`/`unverified` delivery outcomes. A launch on a rule-less project
   records `no-rules`/`none` (lib/sessions.js:579) — a row whose own comment says
   it exists to prove the launch path ran — and the reader discards it, falling
   through to `unaware` ("no evidence"). Same for `skipped`. Deterministic:
   DateDealer session 903 (fresh launch on v5.16.0, 2026-09-01) came out red.
2. **#1140** — the launcher prepends `<repo>/bin` to PATH via tmux `-e`, but the
   pane shell's rc processing (macOS path_helper + user rc) rebuilds PATH before
   the launch command runs. Verified: pane's live claude process has no repo bin
   anywhere in PATH; `which tc` fails. So no session can earn a `confirmed`
   receipt. Mechanism itself is sound — `node bin/tc whoami` by path attributed
   cleanly (receipt 2, project 14 / session 902).

## Probe evidence (2026-08-31, live host)

- tmux session env carries the prepend; the pane process does not → stripped at
  spawn, not at launch.
- `tmux new-session ... 'export PATH="<bin>:$PATH"; command -v tc'` → resolves.
  The command body executes AFTER rc processing, so an embedded export survives.
- Children of a process whose env carries the prepend keep it (login zsh demotes
  it to the tail but `command -v tc` still resolves; nothing shadows `tc`).

## Chunk 01 — #1139: score every ledger outcome honestly

`lib/store.js` `sessionAwareness()`: enumerate the full outcome family
(`delivered`, `unverified`, `skipped`, `no-rules`) instead of two members.
Precedence after receipts (confirmed) and `delivered` (sent) and `unverified`:
- `no-rules` → state `no-rules`, basis "the launch path ran; the project has no
  active rules to deliver — nothing was owed".
- `skipped` → STAYS `unaware` (red). Decision: the existing ACCEPTANCE test pins
  this deliberately ("an explicit non-delivery must NOT soften the state") and
  it is correct — a skip means rules existed and nothing reached the session.
  Descope vs the issue's "no ledger row at all" phrasing; noted in the PR.
- No rows at all → `unaware` (red) — the severed-carrier signature.

Consumers (the family, enumerated):
- `server.js` `/api/awareness` `states` legend (~2816): add the new state.
- `lib/master.js:895` state list in the master guide line: update.
- `public/ui.js`: badge fires only on `unaware` — unchanged behavior, correct.
  Detail-panel ternary already renders non-confirmed/non-unaware as warn; add
  no-rules to a neutral treatment only if trivially cheap, else leave warn.
- `lib/store.js` JSDoc vocabulary blocks (sessionAwareness + fleetAwareness).

Tests (`test/awareness-observability.test.js`): mutation-first — assert a
session whose only row is `no-rules` scores `no-rules`, not `unaware` (fails on
main); assert delivered/receipt precedence over a no-rules row; the existing
ACCEPTANCE test keeps zero-row and skipped-only sessions red.

**Done when:** suite green incl. new red-on-main tests; CHANGELOG `### Fixed`
entry; committed.

## Chunk 02 — #1140: make the PATH floor survive rc processing

`lib/sessions.js` launch path: wrap the built launch command as
`export PATH="<repo bin>:$PATH"; <launchCmd>` so the export executes after rc
files. Keep the tmux `-e PATH` prepend (harmless; correct on shells that don't
clobber). Guard: if the bin dir contains a double-quote-unsafe character
(`"` `` ` `` `$` `\`), skip the wrapper and log the honest reason (never build a
broken command). Degradation note: a launch with no command (bare interactive
pane, `_buildLaunchCommand` → undefined) keeps today's behavior — recorded in
the code comment, not silently.

Tests (`test/` — sessions/engines suite that covers `_buildLaunchCommand` /
launch composition): assert the composed tmux command embeds the export prefix
ahead of the engine command; assert the unsafe-char guard skips with a log.

**Done when:** suite green; CHANGELOG `### Fixed`; committed. Live VRF is
post-merge (this worktree's code is not what launchd runs): after merge +
server restart, launch a pane and `which tc` + `tc whoami` must resolve and
write an attributed receipt. Record in PR as the operator-visible test plan.

## Out of scope

- Backfilling pre-ledger history (relaunch now self-heals under chunk 01).
- Scoring the config-file bootstrap-line carrier in the delivery ledger.
- Receipt attribution for message verbs (accepted R-2 blind spot).
- A launch-time in-pane self-check for `tc` resolvability (#1140 notes it;
  file separately if wanted).

## Status

- [x] Chunk 01 — #1139 scoring fix + tests
- [x] Chunk 02 — #1140 PATH wrapper + tests
- [ ] Critic (cumulative) + resolutions
- [ ] PR (Fixes #1139, Fixes #1140), merge, live VRF, server restart

## Context

Chunks 01 (326ad4e) + 02 committed, suite green (6938 pass / 0 fail).
Mutations red: no-rules test red pre-fix; wrapper-unwired red. Next: Critic
cumulative, then PR. Live VRF of #1140 is post-merge + server restart.
