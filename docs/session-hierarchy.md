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
`delete_project` (`DELETE /api/projects/:name`, `server.js`, outside every file envelope this
car has had) is already safe without any `#1578`-specific code at all: it requires
`operatorProjectCaller`, which a PROJECT-kind caller -- a configured superior included -- never
satisfies. Verified by reading the route, not assumed. It just means that route's refusal reads
as a generic operator-only one rather than a hierarchy-aware `SUPERIOR_ACTION_FORBIDDEN` -- the
same cosmetic (not security) gap `DELETE /api/sessions/:project` had before this PR named it
explicitly, left here as a legibility improvement for a future car in that file's actual scope.

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

## Wired into the real startup text

The actual text a live session reads at `tc start next` (and the pasted push-mode prime) is
assembled by `lib/sessions.js`'s `_collectPrimeSections` -- the function that already builds the
`## Session Ownership`/`## Scope Guard` identity block. It calls
`launch-sequence.js#sessionHierarchyAddendum(project)` (itself built on
`operating-primer.js#appendSessionHierarchySection` and `lib/session-hierarchy.js`'s own
generators) right after the scope guard, in the same `add('identity', ...)` shape
`sessionOwnership` already uses, and appends the result whenever it is non-null. Both
`renderLaunchSteps` (pull/`tc start next`) and `generatePrimePrompt` (push) share this one call
site, so a configured subordinate or superior sees its block through either delivery path.
(Ruling A506-W2B-SCOPE-R1 widened this car's file envelope to include `lib/sessions.js` for
exactly this wiring, after the Allowed File Envelope originally excluded it.)

## Wired: Medusa sender verification

`lib/medusa.js`'s `getMessages(sessionId)` (Ruling A506-W2B-SCOPE-R2 widened this car's file
envelope to include it) annotates every returned message with `fromConfiguredSuperior`: whether
its `from` is the recipient's project's configured superior's CURRENT active session, via
`isAuthorizedSuperiorSender` -- never a stale workspace id. This module stays deliberately
store-agnostic otherwise (every other function here works from a caller-supplied path/id alone),
so the lookup degrades to `false` rather than throwing when no SQL store is available at all --
the same posture every other optional fact in this module takes. The annotation is purely
descriptive: `lib/medusa.js` makes no authority decision itself. A consumer that treats an
incoming "prepare to wrap"/"prepare to clear" instruction as authoritative checks this flag
before acting on it.

## Verified, not wired (no code needed)

`delete_project` needs no `#1578`-specific code: see "Never delegable" above -- `DELETE
/api/projects/:name` already requires operator identity, which a configured superior never
satisfies. That route (in `server.js`) could still get an explicit, hierarchy-aware
`SUPERIOR_ACTION_FORBIDDEN` refusal for legibility, the same improvement `DELETE
/api/sessions/:project` got in this PR -- cosmetic, not a security gap, and left for whichever
future car's envelope actually includes `server.js`.
