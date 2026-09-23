---
title: "Train B.2 Chunk 1: the projects API answers each caller only what it owns"
status: COMPLETE — Chunk 1 built and reviewed; archived with the PR that closes #1739, #1746, #1261
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (messages 6c164c5b, 4dff65c5), confirmed by the operator in-session
issues: [1739, 1746, 1261]
governed_by:
  - docs/adr/0009-secure-by-default.md
  - lib/shared-docs-access.js   # the caller resolver #1626 introduced; reused, not re-derived
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION
scope: train-b2-chunk1
branch: fix/b2-chunk1-projects-authz
partition: serial — every change is in server.js's projects/audit route block plus one small shaping module
critic_mode: chunk
---

# Train B.2 Chunk 1: the projects API answers each caller only what it owns

Train B.2 (fail-closed security investigation and patch) is split into three chunks of at most
four issues each. The PM ratified this split on 2026-09-22. This is Chunk 1. #1444 moved out of the train.

## What the investigation found (read at `eefacdd55`)

1. **#1739.** `GET /api/projects` answers any caller with every project. It includes each
   project's absolute `path` and its `groups`, plus several more fields that the issue did not name
   but that disclose the same thing: `git` (branch, dirty flag, head sha), `sessionHealth.newPaths`
   (file paths inside the project), `ports`, `stranded`, `evalAudit`, and the full engine profile.
   Unregistered directories come back with their `path` too. The `scan` block carries
   the projects directory (`dir`) and a `hint`. **The sibling `GET /api/projects/:name`
   returns the same enriched row to any caller**, so closing only the list would leave the
   disclosure open one URL over.
2. **#1746.** `projects.checkDeletePassword` returns `allowed: true` whenever `deletePassword` is
   unset, which is the shipped default. So `DELETE /api/projects/:name` (and `deleteFiles: true`,
   an `rm -rf`) answers any caller. `archive` and `unarchive` have no check at all.
3. **#1261.** `POST /api/audit/ingest` authenticates the connection. When no project is bound to
   that connection, it attributes the exchange to `body.project`, a name the client supplies, or
   to the literal string `'unknown'`.

**Callers inventory:**
- `GET /api/projects` is used by the dashboard (`public/landing.js`, `public/ui.js`, which are
  browser requests, so the operator), by the Project Master (its prime lists the route and
  mentions `groups`), and by agent panes ad hoc.
- `DELETE` is called only by the dashboard (`public/ui.js`); archive and unarchive likewise.
- Ingest is called only by the OpenClaw webhook.
- `tc` calls none of them.

## Design

The caller is resolved once, with `sharedDocsAccess.resolveAccess` from #1626. Deny by default:
anything that is not the operator, the verified Master, or a bound project gets the least.

### #1739: shape each project row for the caller (`lib/project-view.js`, new)

| Caller | Own project | Any other project |
|---|---|---|
| operator (dashboard session, or browser-shaped with the gate down) | full row | full row |
| Project Master (verified binding) | — | full row (the Master oversees every project; it already reads every group) |
| bound project | full row | public projection |
| unbound / invalid binding | — | public projection |

**Public projection** is an allowlist, not a denylist, so a field added later is withheld by
default. It contains `id`, `name`, `registered`, `archived`, `tags`, `engine: {id, name}`, and
`session: {active, status, startedAt}` or `null`, plus `restricted: true` so a consumer can tell a
shaped row from a full one.

The `scan` block is shaped as well: a non-operator, non-Master caller gets `{complete, code,
listed}` and no `dir` or `hint`. The same function shapes `GET /api/projects/:name`.

The list is **not** refused for unbound callers. A roster of names and engines is what agent
panes use it for today, and none of them sends a binding. Refusing would break them for no gain,
because names are also visible via the switchboard roster.

### #1746: destructive project routes are operator-only

`DELETE /api/projects/:name`, `POST /api/projects/:name/archive` and `.../unarchive` require the
operator (`server.js#projectOperatorCaller`, on the same resolver), answered `403 OPERATOR_ONLY` before any lookup.
When `deletePassword` is set, DELETE still also requires it. The password becomes a second key on
top of operator identity, and no longer the only key.

### #1261: an unbound connection's exchange is refused

When the authenticated connection has no project bound to it, ingest answers
`409 CONNECTION_UNBOUND` and stores nothing. The client-supplied `body.project` is never read.

## Decisions (each one vetoable)

- **[DECISION] The Master gets full rows.** The Master prime already describes the route as
  returning groups, and the Master already reads every group under #1626. The prime line is updated
  to say to send the Master binding headers, or the Master gets the public projection.
- **[DECISION] Refuse, don't re-attribute, for #1261.** The issue offers two options: store against
  the connection, or refuse. Refusing needs no schema change, and a row attributed to no project is
  one "nobody can act on" (issue text).
- **[DECISION] archive/unarchive are included in the #1746 sweep.** They are the other state
  changes the issue names, and they have the same single caller (the dashboard).

## Out of scope (filed separately if not already)

- `POST /api/projects/repair-orphan-hooks`, `POST /api/projects/attach`, `POST /api/projects/import`,
  `PATCH /api/projects/:name` and the `:project/stranded-wraps` family are still unauthenticated
  for any loopback caller. These are not in this chunk's issues and are filed as #1752.
- With the gate stood down (`open`/`fallback`), a dashboard on **plain http** from another machine
  sends no `Sec-Fetch-Site` (browsers send it only to HTTPS or localhost) and no `Origin` on a GET, so
  the resolver does not see the operator. It then gets the public view. #1626 has the same limitation
  on the groups reads. `armed`/`locked` gates and HTTPS installs are unaffected, and the live install
  is `armed`. Filed as #1753.

## Requirements Confidence: **High** for #1746 and #1261, **Medium** for #1739

The #1739 projection is a judgment call: which fields an agent legitimately needs about a project
it does not own. The allowlist is small on purpose, and widening it is a one-line change.

## Chunks

### Chunk 1: projects API authorization (#1739, #1746, #1261)

Done when:
- A bound project sees its own full row and every other project in public projection, in both
  the list and `:name`. An unbound caller sees only public projections. The operator and the
  verified Master see full rows. A test covers each caller kind, and each asserts that `path`,
  `groups` and `git` are absent from shaped rows.
- DELETE, archive and unarchive answer `403 OPERATOR_ONLY` to unbound and bound-project callers,
  with no password set, and the project is still there afterwards. The operator succeeds. A set
  password is still enforced for the operator.
- Ingest from a connection with no bound project answers 409 and stores no exchange. A bound
  connection's exchange lands under its project.
- Existing tests that played an unbound caller against these routes are migrated to name their
  caller. Their assertions are not weakened.
- `docs/configuration-reference.md`, `.prawduct/artifacts/api-contract.md` and the Master prime
  describe the new behavior. The CHANGELOG has a `### Security` entry.
- `/prawduct:critic` has run clean of blocking findings.

## Status

- [x] Chunk 1: projects API authorization (#1739, #1746, #1261). Critic: 0 blocking (rev-20260922T003440Z-532fb0c1). Warnings R-3/R-4 and note R-1 fixed and verified (rev-20260922T003816Z-e34141a4). R-2/R-5/R-6 and O-1..O-4 accepted; the R-2 gate unification is noted on #1752.
