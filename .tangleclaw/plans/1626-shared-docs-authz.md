---
title: "#1626 — Shared documents answer only to a caller bound to a project in the group"
status: IN PROGRESS — PM verified traceability 2026-09-21 (msg fbae32e1); Chunk 01 authorized, later chunks need their own go
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-21 (message 2ecd5ef4) — Hotfix B.1, PRAWDUCT planning only; Train A HELD
issue: 1626
governed_by:
  - docs/adr/0009-secure-by-default.md                 # via .prawduct/artifacts/security-model.md "Direction"
  - docs/adr/0015-tangleclaw-owns-authentication.md
  - docs/adr/0016-tier-1-auth-build-decisions.md
  - .prawduct/artifacts/api-contract.md                # §13 Groups, §14 Shared Documents, §21 tc provenance headers
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION
scope: hotfix-b1-shared-docs-authz
branch: fix/1626-shared-docs-authz
partition: serial — every chunk edits the same route block in server.js and the same new access module
---

# #1626: shared documents answer only to a caller bound to a project in the group

## Acceptance gate (PM, verbatim, 2026-09-21)

> Require explicit server-side caller/project/group authorization; deny bare or unbound
> enumeration; prevent cross-group document and absolute-path disclosure; cover authorized
> same-group, missing binding, invalid binding, and cross-group tests; preserve supported callers
> or migrate them explicitly; and leave current main releasable.

The gate has six clauses. The traceability table at the end maps each one to the chunk and test
that discharge it.

## What the investigation found

Established by reading the code at `a3155b7c7`. None of this is taken from the issue text.

1. **The issue names one door, but the same disclosure has at least five.** `GET /api/shared-docs`
   with no `groupId` returns `store.sharedDocs.list()`, which is every group's documents. But:
   - `GET /api/groups` lists **every group's id** to any caller.
   - `GET /api/groups/:id` returns that group's `docs` (with `filePath`) and its `members` (with
     each project's absolute `path`).
   - `GET /api/groups/:id/members` returns member project paths.
   - `GET /api/shared-docs/:id` returns any document by id.

   So a caller can do `GET /api/groups` and then `GET /api/groups/<id>` to get the same data as
   the bare request, in two calls. The committed carrier that #1619 wrote **tells sessions to use
   exactly those two routes**. Closing only the route the issue names would leave the disclosure
   open under a different URL.
2. **Writes cross groups too.** `PUT /api/shared-docs/:id` can change another group's `filePath`.
   Because documents with `injectIntoConfig` are written into member projects' engine configs at
   launch, a cross-group write means one project can choose which file lands in another project's
   hidden model context. That is a larger harm than the read, and it goes through the same missing
   check.
3. **No per-project credential exists. The only thing that binds a caller server-side is the
   launch id.** `x-tangleclaw-project-id` is a claim, and every surface that reads it says so (the
   #656 PortHub ownership check, `resolveClaimedProject`). The authentication gate grants every
   loopback, non-browser, cookieless request the same machine-client trust
   (`lib/auth-gate.js#isMachineClient`) and has no notion of which project is asking. The one thing
   the server can check is `TANGLECLAW_LAUNCH_ID`. It is minted before tmux starts, exported into
   every project pane whatever the engine (`lib/sessions.js`), bound to a session row in the same
   transaction that creates the row, and resolved with `store.launchSequences.getByLaunchId`.
   `lib/launch-sequence.js` calls it "attribution, not authentication", and that description holds
   here as well (see the threat model below).
4. **Supported callers today.** These are the callers that must keep working:
   - The operator's dashboard: `public/ui.js` does group and document CRUD; `public/session.js`
     calls `GET /api/groups/:id` and `GET /api/shared-docs?groupId=`; `public/landing.js` and
     `public/api-helper.js` call `GET /api/groups`.
   - Project sessions: `data/shared-docs-guide.md` documents list-by-group, register, lock, unlock
     and sync. The committed carrier (`lib/engines.js`) documents `/api/groups` and
     `/api/groups/:id/members`. Agents make these calls with plain `curl` and send **no** identity
     headers.
   - The Project Master: `lib/master.js` lists `GET /api/shared-docs?groupId=<id>` in its Read API
     reference, and the capability line gives it `/api/shared-docs` as fleet-wide read. The Master
     pane has `TANGLECLAW_ROLE=master` only: **no launch id and no session row**, so the server
     cannot bind it yet (see decision D1 and Chunk 02).
   - Server-internal readers (engine-config injection, the shared-doc watchers, broadcast) call the
     store directly. They never go through HTTP and are unaffected.
   - `tc docs` calls the bare `GET /api/shared-docs`. (The plan's first draft said `tc` had no
     shared-docs verb. That was wrong, and Chunk 02 corrected it.) `bin/tc` already sends
     `x-tangleclaw-project-id`, `x-tangleclaw-launch-id` and `x-tangleclaw-role` from the pane's
     environment on every request, so `tc docs` binds with no change: a project's `tc docs` resolves
     as that project, and the Master's resolves as `master` once Chunk 02 exports its launch id.

## Threat model this fix answers, and what it does not claim

The ratified Direction (security-model.md, ADR 0009) says: *"anyone with local shell access
already has everything TangleClaw could give them"*. A same-user local process can read the SQLite
store directly. This fix therefore does **not** claim to stop an adversarial local process, and the
docs will say so plainly.

What it does stop is the failure #1626 actually describes: **a session that follows its own
instructions ends up with visibility into (or write access over) another project's documents.** For
that threat, a server-resolved launch binding is the right strength. It is unguessable, it belongs
to one launch, and it identifies a project by what the server recorded instead of what the caller
claims. A confused agent cannot get another project's view by accident. It would have to read
another pane's environment deliberately. Per-project scoped credentials are listed as AUTH-5+
future work in the security model, and they stay out of scope for this hotfix.

## Design

### The caller-access decision (new `lib/shared-docs-access.js`)

This is one pure resolver. Every shared-docs and groups route asks it, and no route derives
identity on its own:

`resolveAccess(req, deps) → { kind, projectId, groupIds, reason }`

| kind | when | may see / do |
|---|---|---|
| `operator` | the gate is live and `req.tcSession` is an authenticated session, **or** the gate stands down (`open`/`fallback`) and the request is browser-shaped | everything, unchanged |
| `project` | the request carries `x-tangleclaw-launch-id`, it resolves to a session row, that row's project equals `x-tangleclaw-project-id` (**both required**), and the session is not ended | only the groups that project is a member of |
| `unbound` | the request carries no launch id | nothing: **403 `SHARED_DOCS_BINDING_REQUIRED`**, and the message names the two headers and their env vars |
| `master` | (added in Chunk 02) the launch id equals the server-recorded binding of the live Master session **and** `x-tangleclaw-role: master` is sent | every group, **read only** |
| `invalid` | the launch id is unknown, the project claim is missing or doesn't match, or the session has ended | nothing: **403 `SHARED_DOCS_BINDING_INVALID`**, with the reason (unknown / mismatch / ended) |

- The rule is **deny by default**: anything that is not `operator`, a valid `project` or (from Chunk 02) a
  valid `master` is refused. A non-loopback, non-browser caller (for example, curl from another tailnet host while the
  gate is open) is treated as unbound. It is not treated as the operator.
- **No existence oracle.** A `project` caller asking about a group it doesn't belong to gets the
  same **404 `NOT_FOUND`** as a group id that doesn't exist. The same applies to a document id in
  another group.
- **AUTH-4 composes rather than replaces.** The service-token gate still runs first when it is
  enabled. A valid bearer token proves "a fleet client of this install", not "project N", so it does
  not bind a project.
- **Engine-neutral.** The binding is two environment variables that TangleClaw exports into every
  pane whatever the engine, sent as headers. It does not depend on `tc`, `.claude/` or any engine
  UI.

### Route disposition

| Route | operator | bound project | notes |
|---|---|---|---|
| `GET /api/shared-docs` | unchanged | no `groupId` → **its own groups' docs** (issue option 1); `groupId` for a member group → that group; any other `groupId` → 404 | the issue's door |
| `GET /api/shared-docs/:id` | unchanged | only if the doc's group is one of its groups, else 404 | |
| `GET /api/groups` | unchanged | **its own groups only** | stops id enumeration |
| `GET /api/groups/:id`, `…/members` | unchanged | member groups only, else 404 | members of a group it belongs to stay visible, because the carrier's "find your group" step needs them |
| `POST /api/shared-docs` (register) | unchanged | only into one of its groups, else 404 | documented agent operation |
| `POST/GET/DELETE /api/shared-docs/:id/lock`, `POST …/notify` | unchanged | member-group docs only | documented agent operations |
| `POST /api/groups/:id/sync` | unchanged | member groups only | documented agent operation |
| `PUT`/`DELETE /api/shared-docs/:id`, group create/update/delete, membership add/remove | unchanged | **403 `OPERATOR_ONLY`** | not in any agent guide. This is the cross-group context-injection write from finding 2. Migration is explicit (see Chunk 04) |

## Decisions (each one vetoable)

- **D1 (original proposal VETOED by the PM on 2026-09-21; the alternative is adopted): the Project
  Master keeps its fleet-wide shared-docs read access through a server-bound Master launch
  binding, which is built in Chunk 02 before any enforcement.** Why the veto: the gate says
  "preserve supported callers", and the Master is one. Why it has to be a binding and not the role
  header: `TANGLECLAW_ROLE=master` is a claim any process can send, so honouring it would defeat the
  fix with a single header. The Master gets read access only; D3's operator-only writes apply to it
  too.
- **[DECISION D2: Non-member group and document ids return 404, not 403.** | Why: a 403 would
  confirm that the id exists in someone else's group. | vetoable]
- **[DECISION D3: Editing document metadata, deleting documents, and managing groups and
  memberships become operator-only.** | Why: none of these is a documented agent operation, and
  `PUT filePath` is the one that lets a project steer another project's injected context. | veto →
  instead allow them for member groups, which keeps the within-group version of the injection
  steer.]
- **[DECISION D4: The operator is identified by an authenticated session when the gate is live,
  and by browser shape when the gate stands down.** | Why: when the gate stands down, the whole
  dashboard is already open to anyone who can reach it, so a stricter shared-docs test would protect
  nothing. The residual is a local agent that deliberately forges an `Origin` header, which falls in
  the local-process class the Direction already accepts. This is recorded in security-model §3. |
  vetoable]

## Open assumptions

- [ASSUMPTION: A launch id whose session has **ended** should be refused, not honoured. | MED
  impact: a pane that outlives its session row would lose shared-docs access. That is correct, but
  it could surprise someone during a wrap. | can override: honour ended sessions]
- [ASSUMPTION: Panes launched before Train 21 (no `TANGLECLAW_LAUNCH_ID`) fail with a message
  saying "relaunch the session". | LOW impact: every live pane since 2026-09-18 carries it. |
  can override]
- [ASSUMPTION: The Master's binding survives a server restart, because the Master pane does. | MED
  impact: if it didn't, the Master would lose access after every restart. | Chunk 02 persists it and
  answers the lock-in questions listed there first.]
- **Outside callers: checked in Chunk 01, and the assumption was WRONG in one place.** A grep across
  `~/Documents/Projects/*` (excluding TangleClaw's own clones) found one hand-written caller:
  `PV-AI-Guidebook/instruction.json` tells its agent to `GET …/api/shared-docs?groupId=habitat`,
  with no binding headers. `habitat` is a group *name*, not an id, so today that call already returns
  an empty list. PV-AI-Guidebook is a TangleClaw-managed project, so its panes do carry both
  variables. That repo belongs to another session, so the fix goes through the PM: the instruction
  should send both headers and resolve the group id through `/api/groups`. **This must land before
  Chunk 03 enforces**, or that caller moves from an empty answer to a 403. No other outside caller
  was found (the other hits were prose in issue summaries and archived notes). The server log since
  2026-09-20 shows `GET /api/groups` (mostly dashboard polling) and `GET /api/shared-docs` as the
  only traffic on these routes. The log records no caller identity, so it cannot separate the
  dashboard from agents.

## Requirements Confidence: **Medium**

The problem, success criteria and scope are each clear in a sentence. The PM ruled on D1–D4 and the
scope on 2026-09-21. Confidence stays Medium, not High, because two things are still open:
the PV-AI-Guidebook caller has to migrate before Chunk 03, and the persistence design for the Master
binding is not settled. **What would raise it:** the PM routing that migration, and Chunk 02's
lock-in questions being answered.

## Chunks

Each chunk ships as **its own PR**, and main stays releasable after each one. The migration lands
**before** enforcement, so no chunk refuses a caller that hasn't yet been told how to bind.

### Chunk 01: binding primitive and caller migration (no enforcement yet)

**Type:** code · **Critic mode:** final · **Exposed API:** TangleClaw shared-docs API (additive)

- New `lib/shared-docs-access.js`: `resolveAccess` as specified above, with full JSDoc. It is pure
  apart from injected `store` lookups (session by launch id, project memberships).
- **Unit tests** covering every row of the kind table: operator (live gate with a session; stood-down
  gate with a browser-shaped request), bound project, unbound (no headers; project header only),
  and invalid (unknown launch id, mismatched project, ended session, non-integer project id). Plus
  one test showing that a non-loopback, non-browser caller is not `operator`.
- **Migration, sent ahead of enforcement.** `data/shared-docs-guide.md` and the committed-carrier
  text in `lib/engines.js` tell project callers to send
  `x-tangleclaw-project-id: $TANGLECLAW_PROJECT_ID` and
  `x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID`. Extend the #1619 carrier-route pin test so the
  carrier's example requests carry both headers. The Master's Read API line is migrated in Chunk 02,
  together with the binding it will name.
- Verify the outside-caller assumption: grep across sibling repos plus a server-log sample of
  `/api/shared-docs` and `/api/groups` user agents. Record the result in the plan.
- Done when the suite is green, no route behaviour has changed, and the Critic is clean.

### Chunk 02: the Master launch binding (still no enforcement)

**Type:** code · **Critic mode:** final

- At Master launch (`lib/master.js`), mint a launch id the same way `lib/sessions.js` does, export
  it into the Master pane as `TANGLECLAW_LAUNCH_ID`, and record it server-side. Replace it on each
  relaunch, and treat it as ended when the Master session ends.
- **Persisted format, so lock-in. Answer these questions before designing any fields:** Which launch
  id is the live Master's? Did this id belong to a Master that has since been replaced or ended? When
  was it minted (for diagnostics)? Prefer the smallest store addition that answers exactly those
  three, and record the choice in data-model.md.

  **Answered (2026-09-21), and the answer is that nothing is added to the store:**

  | Question | Answered by |
  |---|---|
  | Which launch id is the live Master's? | The `TANGLECLAW_LAUNCH_ID` in the environment of the live `tangleclaw-master` tmux session, read with `tmux show-environment`. `tmux new-session -e` sets the session environment as well as the launch command's, so the id is stored alongside the pane it belongs to. |
  | Was this id's Master replaced or ended? | Any presented id that is not that value is stale. No session means the Master ended. Either way the answer is `invalid` (`master-launch-stale`). If tmux does not answer, the result is `invalid` (`master-unverifiable`), so the check fails closed. A stale id and an id that never existed look the same, deliberately. |
  | When was it minted? | When the session was created (`tmux.sessionCreatedAt`), because the id is minted in the same call that creates the session. The launch log line records the event. The id itself is never logged. |

  **[DECISION D5: The Master's binding lives only in its tmux session environment. There is no table,
  settings row or file for it.** | Why: the pane is the only holder whose value matters. A copy
  anywhere else can drift from it: a Master killed outside TangleClaw would leave a recorded id that
  is still honoured. The tmux value survives a server restart because the pane does, which settles
  the restart assumption, and it takes no schema version, so it cannot collide with Train 21.9's.
  Trade-off: one `tmux show-environment` for each request that claims the Master role, and it fails
  closed. A same-user process can read the value, which is the same local-process class as reading a
  project pane's environment. | vetoable → a single-row store record, at the cost of a schema
  version and a liveness check against tmux anyway.]
- **Resolution order.** The launch id is looked up in the store first. An id that resolves to a
  project launch follows the project path whatever the role header says, so a project pane cannot
  become `master` by adding `x-tangleclaw-role: master`. Only an id the store does not know, sent with
  the role header, is checked against the live Master. Without the role header, an unknown id is
  refused exactly as in Chunk 01.
- **The Master running at deploy time has no launch id,** because it was launched before this chunk.
  It resolves as `unbound` until it is relaunched. That changes nothing now, since no route enforces.
  **Chunk 03 must not enforce until the live Master has been relaunched**, or the Master loses
  shared-docs reads.
- Add the `master` kind to `resolveAccess`, with tests: a live binding plus the role header gives
  `master`; a stale (replaced) Master id gives `invalid`; the role header with no id gives
  `unbound`; a project launch id with the role header gives `project`, never `master`.
- Migrate the `lib/master.js` Read API line and capability line to send the launch id and role
  headers. Update test pins on the Master prime.
- Done when the Master can be resolved, no route behaviour has changed yet, and the Critic is
  clean.

### Chunk 03: enforce on every read door

**Type:** code · **Critic mode:** final

- **Precondition (from Chunk 02):** the live Project Master has been relaunched since Chunk 02
  deployed, so it carries a launch id. Check this before merging: `tmux show-environment -t
  '=tangleclaw-master:' TANGLECLAW_LAUNCH_ID` prints a value.
- `tc docs` (bare `GET /api/shared-docs`, identity headers sent by `bin/tc`) gets the scoped view
  for a project and the full view for the bound Master. Add a test.

- Wire `resolveAccess` into `GET /api/shared-docs`, `GET /api/shared-docs/:id`,
  `GET /api/shared-docs/:id/lock`, `GET /api/groups`, `GET /api/groups/:id` and
  `GET /api/groups/:id/members`, following the disposition table. Filtering happens in the route
  from the resolved `groupIds`. The store API does not change.
- **The gate's four named test classes**, run through `handleRequest` against a scratch store
  (never the live store): **authorized same-group** (a bound project sees its group's docs with the
  bare form and the `groupId` form); **missing binding** (403 `SHARED_DOCS_BINDING_REQUIRED` on each
  read route); **invalid binding** (unknown, mismatched and ended launch ids each return 403
  `SHARED_DOCS_BINDING_INVALID`); **cross-group** (a bound project in group A gets 404 for group B's
  id, B's doc id and B's members, and neither the bare list nor `GET /api/groups` contains any of
  B's `filePath` or member `path` values). Assert on the absence of B's absolute paths anywhere in
  the response body, not only on the status code.
- Master regression: a bound Master still sees every group's docs, and a Master sending only the
  role header gets 403.
- Operator regression: the existing dashboard-path tests (`test/api-groups.test.js`,
  `test/api-shareddocs.test.js`, `test/identity-matrix.test.js`) still pass unchanged, which proves
  the operator path is preserved. Existing tests that call these routes as unbound machine clients
  are **migrated to bind** and are not weakened. Each one is listed in the PR.
- AUTH-4 composition test: with the token gate on, a bound project without the bearer token still
  gets 401, and with the token it gets the scoped view.
- When enforcement lands, rewrite the guide and carrier sentence "they do not narrow what you are
  shown — `groupId` does" to describe the scoped answer, and update the comment in the #1626 describe
  block of `test/tracked-carrier-identity.test.js` and the module header of `lib/shared-docs-access.js`
  ("asked by every shared-docs and groups route"), both of which already state enforcement as fact.
- Live check on a scratch server (per live-verification-traps): a real project pane's `curl` from
  the new guide gets its own groups, and a bare `curl` gets 403.

### Chunk 04: enforce on writes and record the model

**Type:** code · **Critic mode:** final

- Wire `resolveAccess` into register, lock/unlock, notify and sync (member-group only), and into
  `PUT`/`DELETE` doc and group CRUD and membership (operator-only, per D3). Tests: cross-group
  register, lock and sync all get 404; a project-caller `PUT filePath` gets 403 `OPERATOR_ONLY`;
  operator CRUD is unchanged.
- Docs, in the same commit: api-contract §13 and §14 (the access table and the new error codes),
  security-model §3 Authorization (the threat model above, the residuals, and D4), and a README or
  guide note if an operator-visible behaviour changed. CHANGELOG `### Security` entry citing #1626.
- Test: a bound Master gets 403 `OPERATOR_ONLY` on every write route (read-only, per D1).
- `Fixes #1626` goes on this chunk's PR only.

## Governing-norm reconciliation

- **ADR 0009 / security-model Direction (secure by default; documentation is not a control).** This
  conforms: the safe behaviour becomes the server default, where today it is only an instruction in
  the carrier. The retroactivity clause ("existing installs must not be broken silently") is met by
  migrating first (Chunk 01) and by refusal messages that name the fix.
- **ADR 0015/0016 (TangleClaw owns authentication; routes never re-derive identity).** This
  conforms: routes read `req.tcSession` and the resolver's answer and never re-derive identity.
  **Inapplicable** to the per-user enforcement part, which is AUTH-5+.
- **api-contract error model (`{error, code}` through `errorResponse`).** This conforms: three new
  codes are documented in the contract.
- **Engine-agnostic project rule.** This conforms: the binding is environment variables exported
  for every engine, and no `.claude/` path is involved.
- No persisted format is introduced (no schema change).

## Risks I'd flag

- **Write enforcement makes the hotfix larger.** The PM ruled on 2026-09-21 that it stays in B.1.
- **Sessions launched before Chunk 01 have the old guide text.** After Chunk 03 they will get 403s.
  Those 403s carry the exact headers to send, so an agent can recover without relaunching.

## Traceability: gate clause → where it is discharged

| Gate clause | Chunk | Evidence |
|---|---|---|
| explicit server-side caller/project/group authorization | 01 (resolver), 02 (Master binding), 03 and 04 (wired into every route) | `resolveAccess` unit tests; the disposition table covers every shared-docs and groups route |
| deny bare or unbound enumeration | 03 | missing-binding 403s; the bare form is scoped for bound callers; `GET /api/groups` is scoped |
| prevent cross-group document and absolute-path disclosure | 03 (reads), 04 (writes that expose or steer paths) | cross-group tests assert B's `filePath` and member paths are absent from response bodies |
| tests: authorized same-group / missing / invalid / cross-group | 03, 04 | the four named test classes, run through `handleRequest` on a scratch store |
| preserve supported callers or migrate explicitly | 01 (project migration), 02 (Master binding), 03 (operator and Master regression) | guide and carrier changes; Master binding tests; unchanged dashboard tests |
| leave current main releasable | every chunk | migrate-before-enforce order; each chunk is its own green PR |

## Status

- [x] Chunk 01: binding primitive and caller migration
- [ ] Chunk 02: the Master launch binding
- [ ] Chunk 03: enforce on every read door
- [ ] Chunk 04: enforce on writes and record the model
