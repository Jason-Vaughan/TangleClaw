---
title: "Train A Car A1: live checkout and coordinated freshness truth"
status: IN PROGRESS — Chunk 1 authorized by the PM; the Architect ruled D1–D11 on 2026-09-22 (message 4b64f386): D6 and D11 modified, the rest approved
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (message 7206bde4)
issues: [993, 1678]
governed_by:
  - Architect roadmap, "Car A1 — live checkout and coordinated freshness truth" (TangleClaw-Architect/.tangleclaw/plans/v5-v6-backlog-census-and-bridge-roadmap.md)
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION (engaged in Chunk 2: the prime line is server-rendered text, no engine hook)
scope: train-a-car-a1
branch: feat/a1-chunk1-live-checkout-truth (Chunk 1)
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

Not authorized yet. The PM authorizes it after Chunk 1 merges. It is outlined here so the
Architect can rule on its decisions now.

- **Repository identity (D7).** A project's repository is its normalized `origin` URL
  (lowercase host, scp and https forms made equal, `.git` and trailing `/` stripped). A
  project with no remote relates to a repository only by an explicit relation (D7). It is
  never grouped by name or directory.
- **One upstream observation per repository (D8).** `git ls-remote origin refs/heads/main`
  runs once per identity from one member clone, and its result is cached with
  `observedAt`. Nothing is fetched into any session's clone. Ahead and behind counts
  come from each clone's own objects when the observed SHA is present locally. Otherwise
  the clone reads "behind, count unknown: upstream commit not fetched here".
- **Surfaces.**
  - `GET /api/projects/:name` gains `checkout` (the Chunk 1 payload plus
    `repository: {identity, upstreamSha, observedAt}`).
  - The session page gets a checkout chip beside `bannerVersion`, fed by the status poll.
  - The prime's `state` step gets one line (D9) that uses the cached-read pattern from
    `ci-status`.
  - The TangleClaw project's own session also shows running versus disk and the restart impact.
- The owner is the project and the session holding that checkout, taken from session
  ownership.

### Chunk 03: One fleet view for the PM and the controller (#1678 close, #993 close)

Not authorized yet.
- `GET /api/checkouts` gives one row per live project session from the same cached facts,
  so the PM, the controller, the Builder and the dashboard can't compute different answers
  (D11).
- `tc freshness` prints it, `tc capabilities` lists it, and docs cover it.
- The cumulative Critic runs here.

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

## Status

- [x] Chunk 01: the live install reports its own checkout truthfully
- [ ] Chunk 02: every related session shows the same upstream target
- [ ] Chunk 03: one fleet view for the PM and the controller
