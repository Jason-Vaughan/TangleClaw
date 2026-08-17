# Build Plan — Train 4 (v5.4.0): "what it could not establish"

**Branch:** `fix/train4-unknown-not-fact`
**Worktree:** `.claude/worktrees/train4` (mandatory — `public/` is served live off the primary checkout)
**Issues:** #941, #937, #920
**Critic mode:** cumulative-final
**Size / type:** Medium / bugfix (3 chunks)
**Baseline:** 6172 tests, 0 fail, 1 skipped @ `44b3f47` (Release 5.3.0)

## Theme

All three cars are one defect class: **code reporting as established fact something it never
established.** Trains 1–3 closed this on the tmux read surfaces (#906/#905/#907) and the dashboard
(#709/#924). This train closes the three that were named but left open.

## Requirements Confidence: High

1. **Problem.** (a) A session tab loops "Connection lost. Retrying…" forever against a dead server —
   #709's escalation was built on the dashboard only. (b) The escalation ceiling counts *attempts*,
   so background-tab timer throttling makes it fire minutes apart across the operator's open tabs.
   (c) `_liveness` reports a wedged tmux as "not live". (d) `detectExistingProjects` would
   auto-register the running install.
2. **Success.** A session tab against a dead API shows a persistent banner naming what is unknown
   while the terminal stays usable; every open tab escalates on the same elapsed-time ceiling;
   `_liveness` distinguishes "not there" from "did not answer" and no consumer reads the unknown as
   dead; `detectExistingProjects` never returns the running checkout.
3. **Out of scope.** Cross-tab coordination (BroadcastChannel). A full-screen overlay for the
   session page — reserved for a confirmed-dead terminal, not built here. Converting
   `detectExistingProjects` to the bounded async form (#859 — its own issue).

## Decisions

- `[DECISION]` **Session page gets a persistent banner, not #709's overlay.** Operator-chosen
  2026-08-15. The overlay's premise — "nothing underneath can work" — is false here: the ttyd
  terminal (`public/session.html#terminalFrame`) is a separate port and dies independently of the
  API. Covering a live terminal because a status poll failed would be rude, not honest.
- `[DECISION]` **Ceiling moves from attempt-count to elapsed time.** `UNREACHABLE_AFTER = 4`
  attempts is not throttle-stable; browsers clamp background-tab timers to ~1/min, so the same
  outage escalated at ~20s in a foreground tab and ~4min in a background one. Elapsed time makes
  every tab agree without any tab talking to another. A throttled tab still escalates on its first
  post-ceiling wake (~60s worst case) rather than at 4 minutes — better, and honestly bounded.
- `[DECISION]` **The reconnect policy is extracted to one shared module.** #941 exists *because*
  the reconnect loop was duplicated in `landing.js` and `session.js`, so #709 could be built on one
  and not the other. Fixing the duplication is the root-cause fix; leaving two copies guarantees a
  third divergence. New `public/reconnect-policy.js`, consumed by both pages.
- `[DECISION]` **#920 gets the exclusion, not deletion.** The issue offers either. Callers today are
  only tests, but the function is exported module surface, and a bounded grep is not proof of
  absence (a repeat defect here). Excluding closes the hazard at a fraction of the risk.

## Chunks

### Chunk 01 — #941: shared reconnect policy, elapsed ceiling, session-page escalation
- `public/reconnect-policy.js` (new): `tcCreateReconnectPolicy` — outage clock, elapsed-time
  ceiling, jittered retry, injected `now`/`schedule`/`cancel`/`random` for testability.
- `public/landing.js`: consume the policy; keep the existing full-screen unreachable card.
- `public/session.js`: consume the policy; new persistent banner naming what is unknown, carrying
  #709's host-side checks and a Retry button. Must not cover `#terminalFrame`.
- `public/session.css`: banner styles. `public/session.html`: script tag + banner mount point.
- **Done when:** ceiling fires on elapsed time under a throttled clock; both pages share one policy;
  the session banner leaves the terminal frame visible and interactive; recovery dismisses + resets.

### Chunk 02 — #937: `_liveness` reports what tmux could not establish
- `lib/session-ownership.js#_liveness` → `tmux.probeSession` (the #900 primitive), returning the
  tri-state. `_toOwnership` carries it on the ownership object per the family convention
  (`null` + `incomplete` naming the field + `cause`).
- **Consumers are the real work** — the last train's Critic caught exactly this: `listLiveProbed`
  and `scopeGuardSection` both `.filter(o => o.live)`, which silently drops an *unestablished*
  liveness as dead. Both must keep what they cannot disprove.
- **Done when:** a wedged tmux yields `live: null` + `incomplete: ['live']` + a cause, and neither
  consumer drops it; a genuinely-absent pane still reports `live: false`.

### Chunk 03 — #920: `detectExistingProjects` never offers the running install
- `lib/projects.js#detectExistingProjects`: skip the entry whose realpath is `OWN_INSTALL_REALPATH`,
  matching #708's `scanDirectoryForProjects` exclusion.
- **Done when:** a projects directory containing the running checkout does not return it, and a
  mutation removing the guard turns the new test red.

## Status

- [x] Chunk 01 — #941 session escalation + shared elapsed-time policy
- [x] Chunk 02 — #937 `_liveness` tri-state + consumers
- [x] Chunk 03 — #920 own-install exclusion
- [x] Cumulative Critic + resolutions
- [x] PR + merge — #942, squash-merged as `db7c08c`
- [x] Release cut v5.4.0 — #943 (`release/5.4.0`), awaiting CI + merge

Critic took three rounds, which is the record worth keeping:
1. **cumulative** — 0 blocking, 14 warning, 9 note. 18 fixed, 5 accepted with reasons.
2. **verify-resolutions** — 11 of 13 verified, **2 blocking**. Both mine: the ceiling fix did not
   actually deliver the ceiling (a probe stalling *below* it left no timer pending at all, so the
   pre-probe check could never run), and three finding-fixes had no guard and mutated green. The
   prose I wrote also claimed the unfixed case was fixed.
3. **verify-resolutions** — 0 blocking, 0 findings.

Two of my own guards proved vacuous under mutation and were removed rather than shipped: a
generation check `escalateIfDue` made unfalsifiable, and a test harness whose `cancel` cleared the
whole timer queue — which let "end() cancels the ceiling" pass with that cancel deleted.

Suite: 6212 tests, 0 fail, 1 skipped (baseline was 6172/0/1 — +40 new).
Every guard mutation-verified: each chunk's fix was reverted or inverted and the new tests went
red, then green on restore. Chunk 03's first fixture was VACUOUS — a symlinked stand-in is
reported by `readdirSync` as `isSymbolicLink()`, not `isDirectory()`, so it was skipped before
reaching the guard and all three mutations stayed green. Rebuilt around the real shape (the scan
pointed at the install's own parent) before it measured anything.

## Context

Autonomous build authorized by the operator 2026-08-15 ("work on this autonomously… only stop if
there's less than 15% confidence"). Target: v5.4.0 ready to ship on their return.
