---
title: "Train A Car A1: live checkout and coordinated freshness truth"
status: COMPLETE — Chunks 1–3 shipped (#1788, #1791, #1794); #993 and #1678 closed
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (message 7206bde4)
issues: [993, 1678]
governed_by:
  - Architect roadmap, "Car A1 — live checkout and coordinated freshness truth" (TangleClaw-Architect/.tangleclaw/plans/v5-v6-backlog-census-and-bridge-roadmap.md)
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION (engaged in Chunk 2: the prime line is server-rendered text, no engine hook)
scope: train-a-car-a1
branch: feat/a1-chunk3-fleet-view
partition: serial. Chunk 1 is one probe module, one route payload and two dashboard banners; the parts share the new module
critic_mode: chunk (Chunks 1–2), cumulative at Chunk 3
---

# Train A Car A1: live checkout and coordinated freshness truth

## Acceptance gate (from the train manifest)

The operator, controller, PM and Builder observe the **same** checkout identity and freshness facts:
branch or detached state, checkout SHA, observed origin/main SHA, ahead/behind/diverged,
dirty/untracked state, observation time, checkout owner, and running-versus-disk identity.
Missing evidence is `unknown`, never an unqualified green result. **Visibility only:** nothing
refuses service, checks out a branch, discards work, restarts, or gates a mutation.

## Confidence check

1. **Problem.** TangleClaw's served checkout can sit on a feature branch with unpushed commits
   and scratch files, and nothing says so (#993, observed 2026-08-18). Sessions working the
   same repository from different clones can't tell which commit each one is on, or whether
   origin/main has moved (#1678). The existing "server is stale" banner fires on doc-only commits, so it
   teaches the operator to ignore it (#1678 refinement, 2026-09-20). The behind-origin check
   reports every failure as "0 behind", which is an unqualified green result.
2. **Success.** In Chunk 1, the dashboard names the live checkout's branch, unpushed commits,
   uncommitted changes and untracked files. The stale banner says whether a restart matters
   ("records-only, no restart needed"). A failed origin check reads "unknown", not "up to date".
   In Chunk 2, every related session shows the same upstream target and its own checkout
   state, both in its session page and in its prime. In Chunk 3, the PM and the controller
   read those facts from one endpoint and one `tc` verb.
3. **Out of scope.** Auto-pull, restart automation and the action layer are #1710. Moving the
   runtime off a Builder checkout is #1672. Any enforcement or mutation gate needs a separate
   issue or ADR. So does fetching into another session's clone.

## Chunks

### Chunk 01: The live install reports its own checkout truthfully (#993 core, #1678 classifier)

**New `lib/checkout-state.js`.** It gathers checkout facts for one directory and fails
closed. It is async (`execFile`, argv form, `GIT_TERMINAL_PROMPT=0`), makes one flight at a
time, and caches its result for 30s. The route never waits on it: the first poll returns
`state: 'pending'`. Every fact has a value or `null` plus a reason. It returns:

```
{ state: 'measured'|'pending'|'unknown'|'no-git', reason, measuredAt,
  branch, detached, headSha,
  upstream: { ref: 'origin/main', sha, observedAt, observation: 'fetched'|'local-ref'|'unknown' },
  ahead, behind, relation: 'equal'|'ahead'|'behind'|'diverged'|'unknown',
  unpushed: { count, against: '<branch>@{u}'|'origin/main'|null },
  dirtyTracked: <count>, untracked: <count>, onDefaultBranch: bool|null }
```

The facts come from `git status --porcelain=v2 --branch -z`,
`git rev-list --left-right --count HEAD...origin/main`, and `rev-list @{u}..HEAD` (or
`origin/main..HEAD` when the branch has no upstream). The `origin/main` SHA is the local
ref. `observedAt` is the time this process last fetched it successfully, taken from
behind-origin. With no successful fetch this run, `observation` is `'local-ref'`, the
age is unknown, and the UI says so.

**Change classification: `classifyRange(fromSha, toSha)`** returns `executable`,
`records-only`, `mixed` or `unknown`, and lists the paths that decided it. It uses
`git diff --name-status -z` with renames on, so both sides of a rename count. Paths on
the records-only list (D3) are records; every other path is executable. Any failure,
including a SHA the local clone doesn't have, returns `unknown`. `unknown` is shown as
"restart impact unknown" and never as records-only.

**`/api/server-info` (additive, D1):**
- `liveCheckout`: the checkout-state payload for the repository root.
- `restartImpact`: `classifyRange(startupSha, currentDiskSha)` when `isStale` is true, otherwise null.
- `behindOrigin` gains `state` (`measured`|`unknown`|`skipped`|`disabled`|`pending`) and
  `reason` (D2). `commitsAhead` keeps its meaning.

**Dashboard:**
- A new `liveCheckoutBanner` in warning tone, shown when the checkout is off main, detached
  but not at a tag, has unpushed commits, has uncommitted tracked changes, or has untracked
  files. It names each condition with its count and gives the check time. It is
  state-driven: no timers and no dismiss control. Hiding uses `hidden` (display none).
- The stale banner adds the impact: "N commits on disk the server hasn't loaded, records-only:
  no restart needed", and hides its restart button (D6 ruling). For executable or mixed
  ranges it shows the button exactly as today. For unknown it says "restart impact unknown"
  and keeps the button.
- The behind-origin banner stays quiet when the count is 0. When `state: 'unknown'` it shows
  one muted line inside the live-checkout banner: "origin/main not checked: <reason>". That
  replaces the silent 0.

**Tests (written with the code):**
- `test/checkout-state.test.js`, with an injected git seam:
  - one case per relation (equal, ahead, behind, diverged)
  - detached HEAD at a tag, and detached HEAD not at a tag
  - a branch with no upstream
  - dirty and untracked counts
  - porcelain-v2 parsing, including paths that contain spaces or newlines (`-z`)
  - every git failure gives `unknown` with a reason and is never counted as zero
  - single-flight and TTL, with `pending` before the first measurement
  - no git at all gives `no-git`
- Classifier:
  - a records-only range, an executable range and a mixed range
  - a rename from `docs/` into `lib/` counts as executable
  - an unlisted top-level path counts as executable
  - a missing SHA gives `unknown`
  - a real temp repo test (git init in the scratch directory) proves the argv against real git
- `test/server-info.test.js` and `test/behind-origin.test.js`:
  - the new fields are present
  - a fetch failure gives `state: 'unknown'` with a reason
  - a detached HEAD gives `skipped`
  - the disabled flag gives `disabled`
  - existing assertions stay unchanged
- `landing` render tests: each banner condition, the three impact wordings, and that
  "unknown" is never rendered as green.

**Docs:** `api-contract.md` (server-info), `docs/configuration-reference.md` (the
behind-origin row now says what an unknown result means), a CHANGELOG `### Added` entry,
and a FEATURES.md entry.

### Chunk 02: Every related session shows the same upstream target (#1678)

Authorized by the PM on 2026-09-22 (message bb06efbb). Built on `feat/a1-chunk2-related-session-freshness`
in the worktree `.claude/worktrees/a1-chunk2`, because the live checkout stays on `main`.

**Confidence check.**
1. *Problem:* two sessions working one repository from different clones cannot see which commit each is on or
   whether `origin/main` moved; only the live install reports its checkout (Chunk 1).
2. *Success:* any project's session page and its prime name its branch, HEAD, dirty and untracked counts, and
   ahead/behind against ONE upstream SHA observed once per repository, with the observation time. A no-remote
   group member shows the group's repository as "related repo, no checkout comparison". The TangleClaw project's
   session also shows running-versus-disk and the restart impact.
3. *Out of scope:* the fleet view, `tc freshness` and the health-route agreement (Chunk 3), fetching into any clone,
   any gate, auto-pull or restart.

**R-11: one git runner (`lib/git-probe.js`, new).** It holds what `checkout-state.js` and `behind-origin.js` each
kept a copy of: the test-runner spawn block, the resolve-never-reject `runGit(cwd, args, {timeoutMs, network})`
(argv form, `--no-optional-locks` for local calls, `GIT_TERMINAL_PROMPT=0` and ssh batch mode for network calls),
`isNoGit(err)` and a one-line failure reason with remote output redacted. Both modules keep their `_internal`
seams and their exported shapes, so their tests stay as they are. `lib/git.js` stays separate: it is the synchronous
helper that runs inside the directory-scanner child, a different execution model.

**Repository identity (D7): `checkout-state.measure` gains `repository: {identity, reason}`.**
- It comes from one extra local call, `git remote get-url origin`.
- `normalizeRemoteUrl(url)` lowercases the host, makes scp, `ssh://` and `https://` forms equal, strips the
  userinfo (a token in the URL never reaches the identity or any payload), and strips `.git` and a trailing `/`.
  It drops a port only when it is the scheme's default. The path's case is kept, as D7 was ruled.
- A local-path remote becomes `file:<sha256 of its canonical path>` (D14 as ruled). With no origin remote, `identity` is null and `reason` is
  `'no origin remote'`, which is a fact and not a failure.

**One upstream observation per repository (D8, D10): `lib/upstream-observer.js` (new).**
- `observe(identity, memberDir)` runs `git ls-remote origin refs/heads/main` once for each identity, single-flight,
  with a 20s timeout. Its result is cached for 5 minutes as `{state, sha, observedAt, reason, observedFrom}`.
  `observedFrom` is the project name, never a path.
- `snapshot(identity, memberDir, config)` answers from the cache at once and starts at most one background
  observation. It reads `pending` before the first answer. It reads `disabled`, with no call made, when
  `behindOrigin.isCheckEnabled(config)` is false (D10).
- A failed call is `state: 'unknown'` with a reason. It never falls back to the last SHA as if it were fresh: the
  last success stays in `lastKnown`, labeled with its own time.
- Nothing is fetched and no ref is written in any clone.

**Comparison against the observed SHA: `checkout-state.compareSnapshot(dir, headSha, upstreamSha)`.**
- It is cached per (dir, head, upstream) the way `impactSnapshot` is.
- When `rev-parse --verify --quiet <sha>^{commit}` finds the commit locally, it runs `rev-list --left-right --count HEAD...<sha>`,
  which gives `{ahead, behind, relation}`.
- When the object is missing, it gives `{relation: 'behind-unknown', ahead: null, behind: null, reason:
  'upstream commit not fetched here'}`, and that answer is retried on the next read. Any failure is `unknown`.

**Composition: `lib/checkout-freshness.js` (new).** `projectCheckout(project, {config, now})` builds the payload
synchronously from the three caches and starts their refreshes. `refreshForLaunch(project, config)` awaits them,
bounded, for the launch route. The payload is:

```
checkout: { ...checkout-state snapshot (Chunk 1 fields, repository),
  upstream: { identity, sha, observedAt, state, reason, via: 'origin'|'group'|null, groupName? },
  vsUpstream: { ahead, behind, relation, reason },
  owner: { project, sessionId|null },
  runtime: { startupSha, currentDiskSha, isStale, restartImpact } | null }
```

- `runtime` is filled only for the project whose realpath is the running install's repository root.
- `via: 'group'` is the D7 relation for a project with no remote: a member of a group whose other members share
  exactly one identity. It carries that repository's upstream and `vsUpstream.relation: 'not-compared'` ("related
  repo, no checkout comparison"). With zero identities or several, `upstream` is null with a reason.
- `owner` comes from `store.sessions.getActive(project.id)`.

**As built (after the Chunk 2 review).** The block keeps the clone's own comparison with its LOCAL `origin/main` ref
only as `localRef` (so `vsUpstream` is the one answer), and carries `summary`: the sentences `lib/checkout-summary.js#describe`
renders, which the prime and the session chip both show. A no-remote project's launch warm-up reads its group members first,
so the relation is decided for that launch. Git failure reasons are scrubbed of paths and URLs.

**Surfaces.**
- `GET /api/projects/:name` gains `checkout`. It is on the whole row only: the public projection is an allowlist,
  so another project's caller never gets it (#1739 stays closed).
- A session-page checkout chip sits beside `bannerVersion`: "main @abc1234 · equal", or the relation, counts and
  dirty/untracked marks. Unknown is shown as unknown and never as a green state. There are no timers and no
  actions. How it is fed is D12.
- A prime state-step line (D9) follows the CI line. `checkoutFreshness.primeLines(readCached(...))` renders
  "Checkout: <branch|detached @tag> @<sha7>, <relation vs origin/main @<sha7> (observed <age> ago)>; <N uncommitted,
  M untracked>". For the TangleClaw project it adds "Server: running <sha7>, disk <sha7> — <impact wording>". It is
  always one line, so an unknown or pending measurement is said, never omitted. The launch route awaits
  `refreshForLaunch` beside `ciStatus.refresh`, bounded (D13).

**Tests (written with the code).**
- `test/git-probe.test.js`: argv, env and options for local versus network calls, the spawn block, and every error
  resolving rather than rejecting.
- `test/checkout-state.test.js` adds:
  - identity from scp, https-with-token, `ssh://` with port 22, uppercase host and trailing `.git/`
  - no remote gives null with a reason
  - `compareSnapshot` in its present, missing-object and failure cases
  - the missing-object case is retried and not cached
- `test/upstream-observer.test.js`:
  - one call per identity across N callers (single flight)
  - TTL
  - disabled by config and by the environment kill switch, with no call made
  - a failure gives `unknown` while keeping `lastKnown`
  - the ls-remote argv, and that the payload carries no path or URL
- `test/checkout-freshness.test.js`:
  - one project and two clones of one repository read the same `upstream.sha`
  - the group relation with one identity, zero identities and two identities
  - `runtime` only for the install's own repository
  - owner from the active session
  - prime-line wording for each relation, including unknown and pending
- `projects` route test: `checkout` present for the owner and the operator, absent from a public projection.
- A session-page render test for the chip's states.
- A real-git temp-repo test: two clones and a bare origin, one clone behind, both reading the same observed SHA.

**Docs.** `api-contract.md` (the `checkout` field on the project route), `docs/configuration-reference.md` (the
behind-origin setting now also governs ls-remote), CHANGELOG `### Added`, and a FEATURES.md entry.

**Chunk 2 decisions.** The Architect ruled on 2026-09-22 (message 1e80db37): D12, D13 and D15 APPROVE; **D14 MODIFY**, and
the modification is built. A local remote's path is used only as private canonicalization input (resolved against the clone,
then realpath, bounded) and becomes `file:<sha256>`, and no checkout, project or prime payload may expose a raw local path or remote URL.
Failure reasons are scrubbed of paths and URLs (`git-probe.scrubLocations`). Userinfo stays stripped, default ports removed, host
lowercased, and path case preserved.
- **D12 (surface / access).** Feed the session chip by re-reading `GET /api/projects/:name` every 30s (the
  checkout cache TTL), not from `/api/sessions/:project/status`. The status route is unshaped, so adding checkout
  facts there would expose another project's branch and SHAs to any caller and reopen #1739. *Rejected:* adding
  `checkout` to the status payload, as the outline said, because it has no access shaping. Also rejected: a new
  narrow `/checkout` route, because it adds a contract for one chip.
- **D13 (launch path).** The launch route awaits the local checkout measurement and the upstream observation for
  at most 5s together, the same bound `ci-status` uses. Past that, the prime says "upstream not observed yet"
  rather than holding the launch. *Rejected:* an unbounded await, because `ls-remote` is a network call.
- **D14 (identity canonicalization).** Strip the userinfo and default ports, keep the path's case, and map a
  local-path remote to `file:<realpath>`. *Rejected:* lowercasing the path, because D7 as ruled lowercases only
  the host. GitHub's case-insensitivity makes a case-only mismatch possible, and it would read as "different
  repository", not as a false match.
- **D15 (module ownership).** Consolidate the two git helpers into `lib/git-probe.js` (R-11), and leave
  `lib/git.js` (synchronous, scanner-child) alone. *Rejected:* folding everything into `lib/git.js`, because that
  mixes sync scanner code with async server probes.

### Chunk 03: One fleet view for the PM and the controller (#1678 close, #993 close)

Authorized by the PM on 2026-09-22 (message 608a9df0). Built on `feat/a1-chunk3-fleet-view` in the worktree
`.claude/worktrees/a1-chunk3`, because the live checkout stays on `main`.

**Confidence check.**
1. *Problem:* each surface reads one project's checkout (the project route, the prime, the chip), so the PM or the
   Project Master comparing the fleet must make one call per project and each call can land on a different cache
   moment. The health panel's stale-server condition still fires on a records-only range the banner calls "no
   restart needed" (R-12), so two surfaces disagree about the same fact.
2. *Success:* `GET /api/checkouts` and `tc freshness` give the PM, the Master, a Builder and the operator one row per
   live project session, from `checkoutFreshness.projectCheckout` (the function the project route, the prime and the
   chip already use), shaped per caller as D11 ruled. `tc capabilities` lists it. The health condition agrees with
   `restartImpact`. #993 and #1678 close on merge.
3. *Out of scope:* any action, gate, pull, restart or fetch (#1710); moving the runtime (#1672); a dashboard fleet
   panel (the dashboard already renders the same `projectCheckout` per project; a fleet panel is not in either issue).

**`lib/checkout-fleet.js` (new).**
- `visibleProjectIds(access)`: operator and Master → `null` (every project); a bound project → itself plus every
  member of the groups in `access.groupIds`; unbound or invalid → the empty set.
- `fleetView(access, {config})` → `{scope, reason, observedAt, rows}`. Rows come from `store.sessions.listLiveAll()`,
  one per project with a live session (D18), in project-name order, filtered by `visibleProjectIds`, each
  `{project: {id, name}, sessionId, checkout: shapeCheckout(projectCheckout(row), {seesProject, seesGroup})}`.
- `shapeCheckout(block, {seesProject, seesGroup})` is an allowlist (D17): a field added to the block later stays out until someone
  decides it belongs. For a project caller, `upstream.observedFrom` and `upstream.groupName` are nulled unless they
  name a project or group that caller already sees, and `summary` is re-rendered from the shaped block, so the words
  never carry what the fields withhold. `runtime.restartImpact` is reduced to `{impact}`: the path list stays on
  `/api/server-info`.

**`GET /api/checkouts` (server.js).** Resolves the caller with `sharedDocsAccess.resolveAccess`. A binding that was
presented and not honoured is logged and refused with `projectRefusalFor` (`403 PROJECT_BINDING_INVALID`, D16 as ruled);
every other caller gets 200 with `fleetView`. Read-only, cached, never waits on git.

**`tc freshness` (lib/tc-verbs.js).** GETs `/api/checkouts` and prints the scope line, then one block per row:
`<project> (session <id>)` and its `summary` sentences. `scope: 'none'` prints the reason and exits 0: an honest
answer, not a failure. A refused binding is an API error, so `bin/tc` reports it and exits 2. `tc capabilities`: a `checkouts` entry in the project roster and the Master roster (D20).

**R-12: `lib/system-health.js#detectStaleServer` agrees with `restartImpact` (D19).** It reads the same
`checkoutState.impactSnapshot(repoRoot, startupSha, currentDiskSha)` the banner reads. `records-only` → `clear`, detail
"running X, disk Y: records-only commits, no restart needed". `executable`/`mixed` → `fired` as today. `pending` or
`unknown` → `fired`, detail adds "restart impact unknown": never downgraded on missing evidence.

**Carried from the Chunk 2 review.**
- O-1: `checkout-summary.describe` says "related repository not determined" for a no-git project whose group
  relation is `unknown`, as it already does for `pending`.
- O-3: `projectCheckout` moves the `ahead/behind:` and `upstream:` reasons out of `incomplete` into `localRef.incomplete`,
  since they describe the local ref comparison, not the checkout.
- O-4: the `/api/server-info` route reads `serverInfo.getRepoRoot()`, not `serverInfo._internal.repoRoot`.

**Tests (written with the code).**
- `test/checkout-fleet.test.js`: operator and Master see every live row; a project sees itself and its group members
  only; unbound and invalid get `scope: 'none'` with a reason and no rows; a project with no live session has no row;
  the allowlist drops an unknown field; `observedFrom`/`groupName` are nulled for a project caller when they name an
  unseen project or group, and the re-rendered `summary` does not contain them; `restartImpact` carries only `impact`;
  no field holds an absolute path (a sweep of every string in the payload).
- Route test for `GET /api/checkouts` with each caller kind, using `store._setBasePath`.
- `test/tc-verbs.test.js`: `freshness` renders rows, the `none` scope and an empty fleet; it is in the roster and usage.
- `test/system-health.test.js`: records-only is clear; executable and mixed fire; pending and unknown fire with
  "restart impact unknown".
- `test/checkout-summary` cases for O-1; `test/checkout-freshness.test.js` for O-3.

**Docs.** `api-contract.md` (`GET /api/checkouts`, the health condition's wording), the tc verb docs, CHANGELOG
`### Added`, FEATURES.md.

**Chunk 3 decisions.** The Architect ruled on 2026-09-22 (message e0655cb7): **D16 MODIFY**, D17, D18 and D19 APPROVE,
D20 APPROVE as modified by D16. The modification is built: an unbound caller gets 200 `scope: 'none'` with the reason, but
a binding that was presented and not honoured gets the resolver's refusal (`403 PROJECT_BINDING_INVALID`, via
`projectRefusalFor`), and `tc freshness` renders it and exits nonzero; it exits 0 for every answered scope. The Architect
confirmed the build matches (message a1ec562f).
- **D16 (API contract), as proposed (ruled MODIFY above).** `GET /api/checkouts` answers 200 `{scope: 'fleet'|'related'|'none', reason, observedAt, rows}`
  for every caller; unbound/invalid get `scope: 'none'` with the reason and no rows. *Rejected:* 403 for unbound
  callers, the shared-docs convention, because D11 ruled "no rows" and a refusal would make `tc freshness` report an
  API failure where the honest answer is "you are not bound, so you see nothing".
- **D17 (field allowlist).** Rows carry an allowlisted subset of the `checkout` block; for a project caller
  `observedFrom`/`groupName` are nulled unless they name something it already sees, and `summary` is re-rendered from
  the shaped block; `restartImpact` is `{impact}` only. *Rejected:* the project route's whole block (it carries the
  deciding path list and names projects the caller may not see).
- **D18 (row set).** One row per project with a live session, not per session and not every registered project.
  *Rejected:* every registered project, because it measures idle clones nobody asked about and widens what a
  project caller learns.
- **D19 (health contract, R-12).** `stale-server` becomes `clear` for a records-only range and stays `fired` for
  executable, mixed, pending and unknown. *Rejected:* a new `info` state (changes every detector's contract), and
  keeping `fired` for records-only (the disagreement R-12 exists to end).
- **D20 (agent-facing procedure).** A `checkouts` capability in both the project and the Master `tc capabilities`
  rosters, always enabled, naming `tc freshness` and the route; `tc freshness` exits 0 on every answered scope.

## Architectural decisions (sent to the Architect at the plan-written boundary)

- **D1 (API contract).** Add `liveCheckout` and `restartImpact` to `/api/server-info`, and
  `state` and `reason` to `behindOrigin`. All additions are additive, and the existing fields
  keep their meaning. *Rejected:* a new `/api/live-checkout` route, because it adds a second
  poll for the same dashboard. Also rejected: replacing `isStale`, because it would break
  existing consumers.
- **D2 (existing behavior).** A failed behind-origin measurement becomes `state: 'unknown'`
  with a reason, and the dashboard shows it as not checked. Today it is `0` and silent.
  *Rejected:* keeping 0, because it violates the car's "unknown is never green" rule.
- **D3 (classifier policy).** The records-only list is `docs/**`, `test/**`,
  `.tangleclaw/plans/**`, `.prawduct/**`, `.github/**` and top-level `*.md`. Everything else
  is executable, including `data/`, `.claude/`, `deploy/`, `hooks/`, `bin/` and manifests.
  *Rejected:* listing executable paths instead, because a new runtime directory would then
  count as records-only and the failure mode would be a missed restart.
- **D4 (detached HEAD).** Keep behind-origin's no-fetch rule for a detached HEAD. The
  checkout payload still reports detached state, the tag, and a comparison against the
  local `origin/main` ref labeled `local-ref`. *Rejected:* fetching when detached, because
  it undoes #227's reasoning for release-pinned installs.
- **D5 (banner policy).** The live-checkout banner is a warning, not an alert, with no
  restart or checkout actions. It triggers on off-main, detached-not-at-a-tag, unpushed,
  dirty tracked changes, or untracked files. Ignored files never trigger it. *Rejected:*
  a dismiss control, because a dismissed banner hides a production fact.
- **D6 (restart-impact wording).** A records-only range keeps the stale banner but
  replaces the call to restart with "no restart needed". **Ruling: MODIFY.** The banner's
  restart button is hidden for records-only and kept for executable, mixed and unknown.
  The global restart control elsewhere is unaffected. *Rejected:* hiding the banner
  entirely, because the operator should still see that disk moved.
- **D7 (repository identity, Chunk 2).** Use the normalized origin URL. A project with no
  remote, like the Architect, is related only through an explicit relation. I recommend
  project group membership: a no-remote member of a group whose other members share
  exactly one repository identity shows that repository's shared status, labeled
  "related repo, no checkout comparison". With zero or several identities it shows none.
  *Rejected:* grouping by name or path, which the issue forbids. Also rejected: a new
  persisted `relatedRepository` field, because it adds a format for one case.
- **D8 (upstream observation, Chunk 2).** Use `ls-remote` once per repository identity
  and never fetch into another session's clone. *Rejected:* fetching every clone, because
  it takes that clone's git locks mid-work and mutates refs owned by another session.
- **D9 (prime, Chunk 2).** Add one line to the prime's `state` step, for example
  "Checkout: feat/x @abc1234, 2 ahead / 3 behind origin/main (observed 4m ago); 1 untracked".
  It is informational and authorizes nothing.
- **D10 (setting scope, Chunk 2).** `behindOriginCheckEnabled: false` (and the environment
  kill switch) also disables the `ls-remote` observations, and `upstream` then reads
  `disabled`. *Rejected:* adding a second network setting.
- **D11 (access, Chunk 3).** `GET /api/checkouts` is read-only. **Ruling: MODIFY.** It
  reuses the existing caller resolver (`lib/shared-docs-access.js`), but full-view access
  to your own row does not grant fleet visibility:
  - The operator and the Master see every live checkout row.
  - A bound project sees checkout-only, allowlisted fields for itself and for the members
    of its explicit project groups.
  - Unbound or invalid callers get no rows.
  - No workspace paths, and no unrelated projects, are exposed. That keeps #1739 closed.
  *Rejected:* operator-only, because the PM and Builders must read it (that is the
  acceptance gate). Also rejected: the full-view `/api/projects` auth, because it is
  broader than the fleet view needs.

## Done when (Chunk 1)

- The Chunk 1 tests pass, and the full suite is green.
- `/prawduct:critic` reports no unresolved blocking findings.
- The Architect has ruled on D1–D11 (done 2026-09-22), and the D6 modification is built.
- The PR references #993 and #1678 without closing them (Chunk 3 closes both). It merges,
  the live checkout is pulled and restarted, `startupSha` matches, and live
  `/api/server-info` shows `liveCheckout.state: 'measured'`, `branch: 'main'`, and zeros.

## Done when (Chunk 3)

- The Chunk 3 tests pass, and a full TAP run shows 0 fail.
- The cumulative `/prawduct:critic` reports no unresolved blocking findings.
- The Architect has ruled on D16–D20, and any modification is built before the PR opens.
- The PR closes #993 and #1678. It merges, the live checkout is pulled and restarted, and live `tc freshness` from
  this session lists this project's row with `upstream.state: 'measured'`.

## Done when (Chunk 2)

- The Chunk 2 tests pass, and a full TAP run shows 0 fail.
- `/prawduct:critic` reports no unresolved blocking findings.
- The Architect has ruled on D12–D15, and any modification is built before the PR opens.
- The PR references #1678 without closing it. It merges, the live checkout is pulled and restarted, and live
  `GET /api/projects/TangleClaw-Builder1` shows `checkout.upstream.state: 'measured'` with the same `sha` another
  clone of the repository reports.

## Status

- [x] Chunk 01: the live install reports its own checkout truthfully
- [x] Chunk 02: every related session shows the same upstream target
- [x] Chunk 03: one fleet view for the PM and the controller
