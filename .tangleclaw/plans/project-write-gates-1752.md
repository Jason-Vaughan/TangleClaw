---
title: "Gate the project write routes by caller (#1752), and let a stood-down gate recognise the dashboard over plain http (#1753)"
status: ACTIVE — Architect rulings applied 2026-09-22; building to the rulings
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (message 0f96e509)
issues: [1752, 1753]
governed_by:
  - docs/adr/0016-tier-1-auth-build-decisions.md   # direct-mode plain http over the tailnet is a supported shape
  - lib/shared-docs-access.js                      # the one caller resolver (#1626)
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION (not engaged: server-side route policy and one dashboard fetch header)
scope: project-write-gates-1752
branch: fix/1752-project-write-gates
partition: serial. One resolver module, one server.js route family, one dashboard fetch wrapper; the tests that call these routes move with them
critic_mode: chunk
---

# Gate the project write routes by caller (#1752 + #1753)

Train B.2 Chunk 1 (#1746) made deleting, archiving and unarchiving a project the operator's. The
other project write routes still answer any loopback caller. This chunk sorts every one of them
into operator-only or own-project-or-operator, on the one resolver the shared-docs routes already
use. #1753 is folded in because it decides who "the operator" is when the gate stands down, and
every new operator-only check depends on that answer.

### Chunk 01: project write routes answer only the callers they should

## Confidence check

1. **Problem.** Any process that can reach the API on loopback can create, attach or import a
   project, repair hooks in every project, migrate one to the plugin, change another project's
   engine, wrap steps, version file or silent prime (`PATCH`), and run its actions or stranded-wrap
   commands. Nothing asks who is calling, so one project's agent can change what another project's
   next launch and wrap do (#1752). Separately, with the gate stood down, a dashboard loaded over
   plain http from another machine sends neither `Sec-Fetch-Site` nor `Origin` on a same-origin
   `GET`, so its reads resolve as `unbound` and it gets the public view (#1753).
2. **Success.** Each route refuses the callers its group excludes, with a refusal that tells an
   agent what to do. A project's own agent can still `PATCH` its own project, run its own actions
   and work its own stranded wraps. The dashboard is recognised as the operator on every install
   shape it was before, and now also on a stood-down gate over plain http.
3. **Out of scope.** The read routes (`GET /api/projects/orphan-hooks-scan`,
   `stranded-configs-scan`, `GET .../stranded-wraps`): the issue covers writes only, and a read
   answered to a local caller is #1739's shaping question, not this one. Session routes
   (`POST /api/sessions/:project` and friends). Any change to the gate itself.

## Caller inventory (read at `c31dfd464`)

| Route | Callers found | Group |
|---|---|---|
| `POST /api/projects` (create) | dashboard (`public/ui.js` new-project flow) | operator-only |
| `POST /api/projects/attach` | dashboard (`ui.js`); runbook `stand-up-a-new-agent-fleet.md` step 5 (curl from a pane); cleanroom walkthrough step 4 (curl) | operator-only |
| `POST /api/projects/import` | dashboard (`ui.js`) | operator-only |
| `POST /api/projects/repair-orphan-hooks` | dashboard (`public/landing.js` banner) | operator-only: it rewrites hook files in every project |
| `POST /api/projects/:name/migrate-to-plugin` | none in the product; tests only | operator-only |
| `PATCH /api/projects/:name` | dashboard (`ui.js` settings, `public/session.js`); runbook step 6 (curl, another project's engine) | own-project-or-operator; a rename (`name`) is operator-only |
| `POST .../stranded-wraps/{check,ack,open-pr}` | dashboard (`ui.js`); the prime points agents at the read route only | own-project-or-operator |
| `POST /api/projects/:name/actions/:command` | session page (`public/session.js`) | own-project-or-operator |

Server-internal callers (`lib/actions.js`, `lib/stranded-wraps.js`, `lib/stranded-check.js`,
`lib/wrap-steps/*`, `lib/wrap-steps/priming-roll.js`'s `activePlan`) call the library functions in
process, not the HTTP routes, so they are unaffected. `bin/tc` calls none of these routes.

**Nothing is left open.** Every write route has an owner, so there is no "open, because…" row.

[ASSUMPTION: a project renaming itself is the operator's. A rename moves the project's directory,
changes the identity every live binding was issued against, and can leave LaunchAgents naming the
old path (the route already returns that as a warning for the operator). That is more than one
project's configuration. Every other `PATCH` field only changes the project's own config, and
`versionFilePath` is already confined to the project root by its validator.]

## Architect rulings (2026-09-22, message b6c94fef)

Every design decision in this plan went to the Architect. Its rulings:

1. **The Master is refused on every project write, at every access level.** `master.accessLevel`
   (`read-only` by default, `suggest`, `write`) governs the Master's **file** writes through its
   PreToolUse guard. The operator confirmed that toggle stays exactly as built and tested. It never
   granted TangleClaw **API** authority: ADR 0008 keeps the API boundary separate, and #966 is the
   planned scoped grant. Before this change the routes answered any caller, so a Master at any
   level could use them. `PROJECT_READ_ONLY` now says the toggle grants no API authority and
   points to #966. Shared docs stay read-only for the Master. (The Builder had first recommended
   following the level; that recommendation was overruled.)
2. **Ratified:** the `X-TangleClaw-Client: dashboard` label, honoured only when
   `tcGateActive === false`, ignored when armed or locked, never added to `isMachineClient`. The
   ADR 0016 note is marked ratified.
3. **Accepted:** any effective rename is operator-only; sending the current name is not a rename.
4. **Accepted:** `403 OTHER_PROJECT` for a valid bound caller naming another existing project;
   `404` for a missing one; unbound and invalid callers are refused before the lookup.
5. **Accepted:** the route matrix and the runbook rewrite. `actions/:command` admits
   project-scoped actions only: a fleet, identity, destructive-lifecycle or operator action needs
   its own operator-only classification. That is recorded at `lib/actions.js#ACTIONS`, the route,
   and api-contract §2, and a test pins the action list.

**The module keeps its name.** `lib/shared-docs-access.js` now also answers for project writes.
Renaming it would touch every importer and every doc that cites it, for a name change only. Its
header says what it covers. A rename can be its own chore if the module grows again.

## Design

**One gate, in the resolver module.** `lib/shared-docs-access.js` stays the one place that answers
"who is calling"; its header is rewritten to say it serves shared docs, groups and the project
write routes.

- `projectRefusalFor(access, need, action)` is the projects' own refusal function. `refusalFor`
  stays shared-docs only, with its codes unchanged. `projectRefusalFor` accepts only
  `NEEDS.OPERATOR` and `NEEDS.OWN_PROJECT` and throws for any other need. It refuses with
  `PROJECT_BINDING_REQUIRED` / `PROJECT_BINDING_INVALID`, `OPERATOR_ONLY`, and `PROJECT_READ_ONLY`
  for the Master (ruling 1).
- A new `NEEDS.OWN_PROJECT`: the operator, or a bound project caller. The comparison with the
  target is `canChangeProject(access, projectId)`, run after the lookup, like `canWriteGroup`.
- `server.js#projectOperatorCaller` is replaced by two helpers on `projectRefusalFor`.
  `operatorProjectCaller(req, res, action)` names what was refused ("create a project", "rename a
  project"…). `ownProjectCaller(req, res, segment, lookup)` does the whole own-project check in one
  call (binding, lookup, other project), so no route can do half of it.
- Order in an own-project route: binding refusal before any lookup; then the lookup (404 when the
  project does not exist, as today; project names are already public in the roster, so this is not
  an existence oracle); then **403 `OTHER_PROJECT`** when a bound project names another project.

**#1753: a stood-down gate recognises the dashboard by a header it sends.** `tcFetch`
(`public/api-helper.js`), the one way the dashboard reaches the server, adds
`X-TangleClaw-Client: dashboard` to every request. `_isOperator` treats a request as the operator
when the gate stands down and the request is browser-shaped **or** carries that header.

Why a header rather than the issue's `Referer`/`Accept` heuristic: it is explicit, cannot be
stripped by a referrer policy, and is one line in the one wrapper. It adds no security and claims
none: with the gate down any local process can already send `Origin`, and the whole dashboard is
open to whoever can reach it. It is honoured **only** when the gate stands down, so on an armed or
locked install it changes nothing. It is not added to `isMachineClient`'s browser test, so the
fleet carve-out is unchanged.

Writes were never affected by #1753: browsers send `Origin` on every non-`GET` request, same-origin
included. The new operator-only write gates therefore work for a plain-http dashboard with or
without this header; the header restores its reads.

## Tests (written with the code)

`test/shared-docs-access.test.js` (resolver, no server):
- `projectRefusalFor`: unbound → `PROJECT_BINDING_REQUIRED`, invalid → `PROJECT_BINDING_INVALID`,
  Master → `PROJECT_READ_ONLY` (naming #966) or `OPERATOR_ONLY`, project → passes own-project and
  is `OPERATOR_ONLY` for operator; throws for any other need; shared-docs refusals unchanged.
- `canChangeProject`: operator any, project only its own, Master and unbound none.
- `_isOperator` via `resolveAccess`: gate down + dashboard header → operator; gate up + header →
  not operator; gate unstated + header → not operator.

`test/api-projects.test.js` (routes, real server):
- Each operator-only route refuses an unbound caller and a bound project with the right code, and
  the operator succeeds.
- `PATCH`: own project succeeds; another project → 403 `OTHER_PROJECT` and unchanged; unbound →
  `PROJECT_BINDING_REQUIRED`; a rename by the project's own agent → `OPERATOR_ONLY`; the operator can.
- stranded-wraps `ack`, `check` and `open-pr`, and actions: own project passes the gate (`check`
  and `open-pr` reach their handler, which is stubbed off GitHub); another project and unbound
  are refused before the handler runs.
- The bound Master is refused on `PATCH` (`PROJECT_READ_ONLY`) and on create (`OPERATOR_ONLY`)
  through the real routes.

`test/api-actions.test.js`: the registered action list is pinned, so a new action forces the
project-scoped vs operator-only decision (ruling 5).
- The existing delete/archive/unarchive assertions stay as they are.
- A dashboard-shaped `GET /api/projects` with only `X-TangleClaw-Client: dashboard` on a stood-down
  gate gets the operator's rows (paths present).

`test/frontend-csrf.test.js`: `tcFetch` sends the dashboard header on a `GET` and on a write, without mutating the caller's options; a `GET` still carries no CSRF token.

Existing tests that call these routes without saying who they are (`api-actions`,
`api-stranded-wraps`, `api-integration`, `orphan-hooks`, `contracts`, `api-ports`, `e2e-smoke`,
others the suite names) now send `operatorHeaders(server)`; their assertions do not change.

## Docs

- `lib/shared-docs-access.js` header: rewritten for its three route families.
- `.prawduct/artifacts/api-contract.md`: each route's caller rule and refusal codes; the resolver
  table gains the dashboard label.
- `docs/user-guide.md` and `docs/configuration-reference.md`: the gated routes say who may call them.
- `.prawduct/artifacts/security-model.md`: the project write boundary.
- `docs/adr/0016-tier-1-auth-build-decisions.md`: a dated note on how a stood-down gate recognises
  the dashboard over plain http (#1753), and why it is not a security control.
- `docs/runbooks/stand-up-a-new-agent-fleet.md` steps 5–6 and 10a, and `deploy/cleanroom/README.md`
  step 4: attaching projects and setting another project's engine are the operator's. Step 10a's
  verification was already unable to pass from a pane (#1739 hid `releaseMode` from the public
  roster); filed as #1777 and noted in the runbook rather than fixed here.
- `FEATURES.md` and `CHANGELOG.md` (`### Security`).

## Done when

- The tests above pass and the full suite is green.
- `/prawduct:critic` shows no unresolved blocking findings.
- The PR closes #1752 and #1753 and merges. The live checkout is pulled and restarted,
  `startupSha` matches, the dashboard still loads and changes a project setting, and an unbound
  `curl -X PATCH` on the live install gets 403.

## Status

- [ ] Chunk 01 (#1752, #1753): project write routes answer only the callers they should
