# ADR 0008: Project Master — Harness-Session Singleton with a Tiered Write Boundary

**Status:** Accepted (2026-07-03, chunk G / #331). Shipped across three slices: #440 (`lib/master.js` + API), #442 (landing pane), slice 3 (in-session drawer + this ADR).
**Amended 2026-07-18 (Master settings surface v1):** the filesystem half of the boundary is now
**structural** on the Claude engine — every ensure regenerates `.claude/settings.json` plus a
default-deny PreToolUse guard hook in the master home.
The Hard rules moved from hardcoded prose
into editable, versioned `session_rules` rows (kind `master`) with a shipped-baseline restore
path. The **API half is unchanged**: mutation endpoints stay open on localhost, GET-only remains
instructional, and the enforced token scope remains a G2+ concern. See "The read-only boundary"
below for the original v1 posture this amends.
**Amended again 2026-08-17 (#755):** that guard is no longer fixed at read-only. It reads the
operator's access level from `<master home>/.access-level` on every invocation and maps it to
deny / ask / allow, so the guard applies a change on the master's next write attempt — though the
running master keeps the instructions it launched with until it restarts (#968); every
unreadable level degrades to read-only, and the guard's own control surface is refused below the
write tier so no single confirmation can raise it. **That control surface includes TangleClaw's own
`config.json`** — `.access-level` is a copy the next ensure rewrites from it, and the config sits
one directory ABOVE the master home, so refusing only the in-home artifacts left the real switch a
sibling away. `memory/` remains writable at every tier. Two limits stated rather than implied: the
matcher is `Edit|Write|NotebookEdit`, so shell writes are operator-gated rather than hook-enforced;
and this is a Claude-engine capability — elsewhere the level is instructional, carried in the
regenerated identity, and the API reports which it is.
**Amended 2026-08-17 (#755 chunk 3):** the status API now reads the boundary BACK — the guard's
presence, its registration in `.claude/settings.json`, its source, and the level on disk against
the level in config — and reports a boundary that is not in force rather than restating the
configured one. Before this a deleted or unregistered hook left every surface saying "structural"
with nothing enforcing.
The original read-only description below is retained as the record of what v1 shipped.
**Source issue:** #331 — Project Master. **Ratified design:** 2026-06-16 interview + D7 (reach-from-anywhere), operator decisions 2026-07-01 (home dir, lifecycle).
**Builds on:** ADR 0005 (AUTH-4 service token — the master's gated-surface credential). **Successor work:** **#966** — a scoped TangleClaw API token and a fleet-mutation route, so the Master's authority over TC's own API is bounded server-side rather than by whatever its engine enforces locally. Filed 2026-08-17 when #755 shipped the file-write tier only; it carries the G2 (post-4.0) actions/relay work, which needs Switchboard #333 as its transport.

---

## Context

Every TangleClaw session is project-scoped: one project, one tmux session, one engine, one set of
per-project machinery (wrap pipeline, idle watchdog, dashboard card, ownership). There was no
surface for **cross-project** questions — "which projects have open PRs?", "what's stale?" — or for
instance-wide conversation. The gap wanted a control-plane assistant *above* all projects,
reachable both from the landing page and from inside any running session (D7: an operator deep in
a session should not have to leave it to ask a fleet question).

Two architectural forces shaped the answer:

- **TC is a coordinator, not an LLM host.** Building a TC-owned chat loop means an LLM
  integration, API keys, a model axis, streaming transport, and a custom chat UI — a second
  product. TC already knows how to launch and front harness sessions (Claude Code in tmux behind
  ttyd); the cheapest correct assistant is another one of those.
- **Everything project-shaped keys on the projects table.** Wrap, watchdog, dashboard cards,
  scope guard, and ownership all assume a `sessions` row joined to a project. A global singleton
  jammed into that machinery would inherit lifecycle behaviors (idle-kill, wrap prompts,
  dashboard cards) that are all wrong for a persistent fleet assistant.

## Decision

The Project Master is **one persistent, harness-session-backed Claude Code session** — a parallel
singleton beside the project machinery, not inside it:

1. **Reserved tmux session `tangleclaw-master`** (exported constant). Project names come from the
   projects table, so the name cannot collide; the dashboard's session machinery never sees it.
2. **No `sessions` row, no project.** The master is invisible to wrap, watchdog, dashboard cards,
   and ownership — deliberately. Its lifecycle API is three operator routes: `POST
   /api/master/ensure` (idempotent create-or-refresh), `GET /api/master/status` (liveness truth
   straight from tmux — no DB row to drift), and `POST /api/master/kill` (#968 — idempotent, and
   refusing rather than claiming a kill tmux would not confirm, since a level change binds on the
   guard at once but the running master only reads its instructions at launch). A structural test pins that `lib/master.js` never
   touches the sessions store.
3. **Dedicated home `~/.tangleclaw/master/`** — a data directory, never a repo clone. A clone
   would share git HEAD with dev sessions (the documented shared-worktree hazard) and hand the
   master a writable project by accident.
4. **Identity via a TC-generated `CLAUDE.md`** in the master home, regenerated on every ensure so
   guide/token changes propagate (marker header, same pattern as engine configs). Claude Code
   reads the cwd `CLAUDE.md` natively — no prime-delivery machinery, survives restarts and
   re-attaches. Contents: the administrator role, a generated statement of the current access
   level and what enforces it (#755), the TC API base URL + read-endpoint guide, the AUTH-4 bearer
   block when the M2M gate is enabled, and the editable Hard rules.
5. **Lifecycle: launch on first open, then persist.** No boot-time launch — the launchd daemon
   context does no interactive/privileged work (root-family learning). Opening either surface
   POSTs ensure; closing a surface never kills the session.
6. **The chat surface IS the terminal.** Both surfaces (landing pane, in-session drawer) embed
   the existing ttyd iframe at `/terminal/?arg=tangleclaw-master`, attached **only after ensure
   succeeds** (ttyd attaches to existing sessions, it cannot create them). This reuses the whole
   verified terminal stack — scrollback replay (#322), the shared frame pipeline
   (`tcWireTerminalFrame`: theme + #431 ⌥+drag copy + #443 touch-scroll + #445 drag-copy) — and
   keeps v1 free of any new chat transport.

## The read-only boundary is instructional in v1 — stated, not silently claimed

> **Superseded in part, 2026-08-17 (#755).** The section below still describes the *API* boundary
> correctly — TC's mutation endpoints remain open and the scoped token is still deferred. What it no
> longer describes is the **file-write** boundary, which is now a real, selectable tier rather than a
> fixed posture: `read-only`, `suggest` (each write outside the master home's memory directory stops
> for operator confirmation) and `write`. The `PreToolUse` guard reads the level from a file in the
> master home on every invocation, so the guard applies a change on the master's next tool call,
> and every unreadable level degrades to `read-only`. (Amended #968: that is true of the GUARD. A
> running master reads its identity only at launch, so it keeps the level it started with until it
> restarts — the original wording said "no restart", which was the opposite of what an operator
> needs to do.) Measured against Claude Code 2.1.233: a hook
> decision outranks the `bypassPermissions` launch mode, so the tier means the same thing on every
> launch mode. Still Claude-only — on other engines this remains instructional, and the API says so.

v1's "read-only" is enforced by **instruction and construction**, not by the API:

- *Instruction:* the regenerated `CLAUDE.md` rules — answer/report, propose but never execute
  mutations.
- *Construction:* no project checkout (the home is a data dir), so there are no project files to
  edit even if instructions fail.
- *NOT enforcement:* TC's mutation endpoints remain open on the direct localhost listener by
  design (single-operator posture; AUTH-4 gates only PortHub/shared-docs). A misbehaving master
  *could* call them.

We ship this boundary honestly documented rather than pretending it is enforced. **Enforcement — a
read-only API token scope — is a G2+ concern**, deferred with the rest of the action surface
(mutations arrive with Switchboard #333 relay and will be confirm-gated; that is the right moment
to introduce scoped tokens rather than inventing a scope mechanism for a v1 that performs no
actions).

## Alternatives considered

- **TC-owned LLM chat loop** (custom chat UI + direct model API): rejected/CUT at ratification —
  a second product's worth of surface (keys, models, streaming, history) duplicating what the
  harness session gives for free.
- **Master as a `sessions`-row project**: rejected — inherits idle-kill, wrap prompts, dashboard
  cards, and ownership semantics that are each wrong for a persistent global singleton; every one
  would need a special case.
- **Boot-time launch from the daemon**: rejected — the launchd context does no interactive work,
  and a master nobody has opened yet is pure idle cost. Launch-on-first-open makes the operator's
  first click the consent.
- **Enforced token scope now**: deferred to G2 — v1 performs no actions, so a scope would gate
  nothing real while adding auth surface; documenting the instructional boundary is more honest
  than shipping ceremony.

## Consequences

- Cross-project status questions get a live assistant at zero new transport/LLM cost; every
  terminal-stack improvement (copy, scroll, themes) applies to the master surfaces automatically
  via the shared pipeline.
- The master is exempt from all project machinery — anyone extending wrap/watchdog/dashboard can
  ignore it, and anyone extending the *master* must not reach for that machinery.
- The instructional boundary is a documented risk accepted for v1; G2's enforced scope closes it
  when actions arrive.
- Operators on a fresh install pay one-time ensure latency on first open (mkdir + CLAUDE.md +
  tmux + engine launch); subsequent opens attach instantly.
