# Session hierarchy

A standing relationship letting one project's session (the **superior**) direct another's (the
**subordinate**) within a fixed set of delegated scopes -- wrap it, clear it, or point it at work --
without the operator in the loop for every call. #1578.

This is a persistent, project-level config an operator sets up once. It is **not** a replacement
for the ephemeral, per-sprint delegated lifecycle authority a control assignment already grants
a Fleet Coordinator or ProjectManager (`CLAUDE.md`'s own #2824 mechanism): that authority lives only
as long as a sprint assignment names the caller, all-or-nothing across wrap/launch/clear. Session
hierarchy is the opposite shape -- it outlives any one sprint, and it is scoped action by action.

## Setting it up

Write `<subordinate-project-path>/.tangleclaw/session-hierarchy.json`:

```json
{
  "reportsTo": "Superior",
  "delegatedScope": ["wrap", "clear"]
}
```

- `reportsTo`: the superior project's name, or its numeric id, as a string.
- `delegatedScope`: any of `plan`, `build`, `pr`, `wrap`, `clear`. An unrecognized or
  operator-reserved entry is a validation **error**, not a silent drop -- `lib/session-hierarchy.js`'s
  `setConfig`/`normalizeHierarchyConfig` refuse to write it.

There is deliberately no SQL migration for this: it is a small JSON file per subordinate project,
the same pattern `lib/medusa-registry.js` uses for its own workspace-id registry.

## Never delegable

However `delegatedScope` is written, and whatever any OTHER authority mechanism (including the
Master, or a #2824 sprint assignment) separately grants the same caller, these never reach a
superior through this relationship:

`external_pr`, `release`, `ci`, `deploy`, `secrets`, `delete_data`, `service_restart`,
`delete_project`, `kill_session`.

The kill-session route (`DELETE /api/sessions/:project`) explicitly refuses a configured superior
with `403 SUPERIOR_ACTION_FORBIDDEN`, named so the refusal reads as "you are a configured superior,
and this is exactly the one thing that never covers" rather than a generic caller refusal.
`delete_project` has no separate HTTP enforcement in this car's file envelope (`lib/routes/sessions.js`
and `lib/routes/wrap.js` only) -- a project-delete route, if this installation has one, lives
elsewhere; wire the same `isConfiguredSuperior` check there before relying on it.

## Server enforcement (what's wired today)

- `POST /api/sessions/:project/wrap` -- a configured superior with `wrap` delegated passes the
  same gate the operator/Master/#2824-delegate already use (`lib/routes/wrap.js`'s
  `_hierarchyOrLifecycleCaller`, additive: it never narrows what already worked).
- `POST /api/sessions/:project/command` with `/clear` -- a configured superior with `clear`
  delegated passes the existing governed-clear gate (`lib/routes/sessions.js`'s
  `_isDelegatedSafeClear`), under the SAME precondition #2824's own delegation already requires:
  the target lane must currently compose `AVAILABLE`/`safe-to-clear`. A busy, held, or stale lane
  refuses a configured superior exactly as it refuses anyone else.
- `DELETE /api/sessions/:project` (kill) -- always refused to a configured superior, explicitly.

## The handshake (what a superior and subordinate actually do)

A superior does not simply issue a wrap/clear mid-sentence. It sends a plain-language instruction
-- `prepare to wrap` or `prepare to clear` -- over Medusa. The subordinate commits its work, writes
its handoff notes, and replies `ready`. Only then does the superior make the real `wrap`/`clear`
call. Neither side infers consent from anything less literal than those exact phrases.

`lib/session-hierarchy.js`'s `generateSubordinateInstructions`/`generateSuperiorInstructions`
produce this handshake's text deterministically, for either side's own startup primer.

## What's NOT wired yet (named here on purpose)

Two integration points this car's file envelope could not reach, left as explicit follow-ups
rather than silently incomplete:

1. **The actual text a live session reads at `tc start next`** is assembled in `lib/sessions.js`,
   not `lib/launch-sequence.js` or `lib/operating-primer.js` (this car's envelope). Both of those
   two now carry a fully tested, ready-to-call composition
   (`operating-primer.js#appendSessionHierarchySection`, `launch-sequence.js#sessionHierarchyAddendum`)
   -- the same "dead code until the next car wires it in" shape `buildOperatingPrimer` itself had
   until #2844. A follow-up car should call `sessionHierarchyAddendum(project)` from wherever
   `lib/sessions.js` assembles its own startup text, and append the result when non-null.
2. **`isAuthorizedSuperiorSender`'s Medusa wiring.** The function itself is built and tested
   (verifies a Medusa envelope's `from` against the configured superior's CURRENT active session's
   registered workspace id -- never a stale one). Nothing in `lib/medusa.js` (out of this car's
   envelope) calls it yet. A follow-up car should check it before treating an incoming "prepare to
   wrap"/"prepare to clear" instruction as authoritative.
