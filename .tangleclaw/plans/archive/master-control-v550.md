# Build Plan — Master Control, part 1 (v5.5.0)

**Branch:** `feat/756-768-master-control`
**Worktree:** `.claude/worktrees/master-control` (mandatory — `public/` is served live off the primary)
**Issues:** #756 (closes), #768 (partial — stays open)
**Milestone:** Master Control (#829)
**Critic mode:** cumulative-final
**Size / type:** Medium / feature (2 chunks)
**Baseline:** to be recorded from a clean run at `2fd859b` (Release 5.4.0)

## Why this train, and why it is late

#829 is the tracking issue for "the first train car after v5", blocked only on v5.0.0 shipping. It
slipped v5.1, v5.2, v5.3 and v5.4 — the last one because the roster for train 4 was assembled from
a severity ranking of open issues instead of from the milestone. The operator's own words in #829:
a `read-only` Master is *"really hobbling"*.

## Scope, honestly

**#756 closes.** It is wiring, not new design: the engine-aware machinery
(`engines.reconcileLaunchMode`, the picker component from #596) already exists and is already
correct. `lib/master.js:627` hardcodes `null` as the launch mode.

**#768 does NOT close, and must not be claimed as closed.** Its own body records that three of five
controls have no Master-side API: Upload has no route (`/api/upload*` resolves through
`projects.getProject`, and the Master is not a registered project), Medusa has no route (every
endpoint is `/api/sessions/:project/medusa/*`), Kill has no endpoint at all
(`lib/master.js:581` — *"no kill/adopt semantics in v1"*). Access level is blocked on #755.

What ships here is the extraction plus the gap #768 names as the sharpest:
**`masterSettingsModal` exists only in `public/index.html`** — `grep -c masterSettingsModal
public/session.html` is `0` — so from inside a session there is no route to the Master's settings at
all. The operator must leave the session, go to the landing page, open the Master panel, and click
the gear, in order to see or change the single most consequential fact about the Master.

## Requirements Confidence: High

1. **Problem.** The Master always launches in its engine's bare default with no way to change it,
   and its settings are unreachable from the surface it is embedded in.
2. **Success.** Launch mode is settable, persisted, reconciled against the Master's *effective*
   engine, and takes effect on the next `ensure`; the drawer header carries a control bar that
   reaches those settings without leaving the session.
3. **Out of scope.** #755 (access level — its own chunk, design reviewed with the operator first).
   Upload / Medusa / Kill for the Master (each a separate backend decision; #768's open questions
   1–3 are unanswered). Wrap for the Master (#768 recommends deferring until it has a meaning).

## Decisions

- `[DECISION]` **Absent, not inert.** Controls with no Master backend are rendered visibly absent
  with an honest reason, never present-and-disabled-looking-clickable. This is the bar #755 and
  #741 both set, and #768 restates it.
- `[DECISION]` **Parameterise by target, do not fork the markup.** The session controls are
  singleton-ID DOM driven by module-global scope (`public/session.js:7`'s `projectName`, fixed ids
  like `#uploadModal`, `#medusaControl`). The drawer lives on the SAME page as the host session's
  banner, so a second copy collides on every id. The shared home is `public/api-helper.js`, which
  already holds the session/master parity helpers.
- `[DECISION]` **Mobile collapse rule deferred with a reason.** #768's open question 4 asks for it
  up front, but it is about six controls at phone width. This bar ships with two, so the density
  problem is not yet real; the rule is owed when Upload/Medusa/Kill land, and is recorded on #768
  rather than guessed at now.
- `[DECISION]` **Two axes stay separate.** #756 is what the Master's own session prompts for
  (engine-enforced, per-engine); #755 is what the Master may do to the fleet (TC-enforced,
  must be engine-agnostic). The modal must make the COMBINATION legible without implying either
  implies the other.

## Chunks

### Chunk 01 — #756: the Master has a launch mode
- `lib/master.js#masterSettings` — carry `launchMode` with a `'default'` fallback.
- `lib/master.js#_masterRuntime` / `#ensureMasterSession` — reconcile against the EFFECTIVE engine
  and pass it to `sessions._buildLaunchCommand` in place of the hardcoded `null` (`:627`).
- `lib/master.js#getMasterStatus` — expose the stored mode, the reconciled mode, and which modes
  the effective engine actually honors, so the UI never re-derives them.
- `server.js#validateMasterPatch` — add `launchMode` to the settable set and validate it.
- `public/ui.js` — picker in the settings modal; unsupported modes visibly unavailable with a
  reason, never silently ignored (#741's bar).
- **Done when:** a stored mode an engine cannot honor reconciles to `default` rather than launching
  it; switching the Master's engine cannot strand a mode; the mode reaches the launch command; and
  a mutation removing the reconcile turns a test red.

### Chunk 02 — #768 (partial): the drawer header becomes a control bar
- Extract the Master control bar into `public/api-helper.js` as a target-parameterised component.
- Render it in BOTH the session drawer header (`public/session.html:172-180`) and the landing
  Master panel, so a second copy cannot grow.
- Carry: gear → Master settings (reachable from a session for the first time), launch-mode control.
- Unbacked controls absent with an honest reason.
- **Done when:** the Master's settings are reachable from inside a session; both surfaces render
  from one implementation (changing it changes both, proven by test); no id collides with the host
  session's controls.

## Status

- [x] Chunk 01 — #756 launch mode — shipped in v5.5.0 (PR #944 → `8d3fe9f`)
- [ ] Chunk 02 — #768: NOT started, deliberately deferred to a fresh session.
      Plan: `.tangleclaw/plans/768-master-control-bar.md`
      Artifact: https://claude.ai/code/artifact/71e990ee-14d1-4945-9b45-c517aeca8523
- [x] Cumulative Critic + resolutions — 0 blocking; three verify rounds, ending 0/0/0
- [x] PR + merge — #944
- [x] Release cut v5.5.0 — #946 → `3d3e48c`, tag v5.5.0 published

## Context

Started 2026-08-15 night, immediately after v5.4.0 shipped, once the operator pointed out that
train 4 was supposed to be this. Sequencing chosen by the operator: header bar + launch mode first,
#755 as its own chunk with its design reviewed before building.
