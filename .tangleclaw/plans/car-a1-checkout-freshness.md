---
title: Car A1 — Live checkout and coordinated freshness truth (#993, #1678)
status: rev 2 — PM verified plan-to-car traceability 2026-09-21 and authorized Chunk 01 ONLY. Chunks 02–05 are not authorized.
authorized_by: TangleClaw-ProjectManager (tangleclaw-projectmanager-6129df86), 2026-09-21 — PRAWDUCT product planning only
issues: [993, 1678]
scope: car-a1-checkout-freshness
# The claim moves chunk by chunk: each authorized chunk's branch is written here when it starts.
branch: feat/993-checkout-freshness
depends_on:
  - artifact: architecture
  - artifact: api-contract
  - artifact: nonfunctional-requirements
governed_by:
  - artifact: architecture
    dispositions:
      - "a dependency's failure degrades, never crashes; an unestablished read reports null and names itself → conforms (the design is built on this norm: every git/remote read carries an evidence state, and a failure is never collapsed to 0 or up-to-date)"
  - artifact: nonfunctional-requirements
    dispositions:
      - "mobile-first, ≥44px targets → conforms; banners are verified at 320–375px (Visual change: yes on chunks 01, 03)"
      - "accessibility floors → conforms; state is carried in text (branch name, 'behind 2', 'unavailable'), never by color alone"
  - artifact: observability-strategy
    dispositions:
      - "logs carry names, never payloads → conforms; logs name the repo path and the failure code, never file contents or remote credentials"
      - "every logged error says what/why/what-to-do → conforms"
  - artifact: security-model
    dispositions:
      - "secure by default → inapplicable because this car adds read-only fields to already-gated routes and no new route surface; the origin URL is normalized and credentials are stripped before it is ever returned"
  - artifact: prime-delivery-direction
    dispositions:
      - "one concern per channel; cost scales with relevance → conforms; the freshness fact rides the existing `state` launch step beside the CI line — one line when current, otherwise a heading, the identity line, one line per finding and a no-action note — and only for a session of the live install's own project"
  - artifact: project-preferences
    dispositions:
      - "no npm dependencies → conforms (git CLI + node stdlib only)"
      - "CommonJS, node:test, JSDoc on every function → conforms"
      - "never auto-close another session → conforms; nothing here acts on any session"
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION → conforms; every fact is computed server-side and delivered through the engine-neutral launch sequence and HTTP surfaces
  - project rule: only the operator may authorize launchd restarts → conforms; this car never restarts, pulls, checks out or stashes (that is #1710)
partition: serial — chunks 01–03 all extend one new module and the server-info payload; 04 depends on 03's per-session facts. Chunks touching `public/` or `server.js` build in a worktree per the live-checkout rule.
last_validated: 2026-09-21
---

# Car A1 — Live checkout and coordinated freshness truth

**Car acceptance gate (from the PM):** Operator, controller, PM and Builder observe the same
checkout identity and freshness facts before mutating workflows begin. Reports and gates only; does
not auto-checkout.

## Requirements Confidence

**Level:** Medium

**Why:** Both issues are specific, and the existing code (stale-server check, behind-origin banner,
launch preflight, prime state step) is inventoried below. The PM settled the related-sessions rule
and the blocking gate's place in the car. Still open: Chunk 05's scope, and how #1672 moves the
serving checkout underneath this work.

**Open assumptions / unknowns:**
- [DECISION: Chunks 01–04 build the facts; a **hard block on mutating workflows** is part of the
  car's final acceptance and lands as Chunk 05 | PM ruling 2026-09-21: "The hard block on mutating
  workflows is part of the car's final acceptance, but Chunk 01 does not need to introduce the block
  yet." This supersedes the rev 1 assumption that no workflow would be blocked. #993's rejection of
  refusing-to-serve still binds: the block refuses the *action*, never the server | PM/operator can
  veto]
- [ASSUMPTION: Chunk 05's blocked workflows, blocking conditions and override holder are UNSCOPED —
  raised with the PM 2026-09-21 for an Architect/operator ruling | HIGH impact | blocks planning 05,
  not 01–04]
- Related sessions = the same **normalized origin URL**, or **explicit** project-group membership.
  Nothing is inferred from a path or a name. The Architect (no remote) is related only through its
  group. *Confirmed by the PM 2026-09-21.*
- [ASSUMPTION: this car does not wait for #1672. The module takes a repo root as a parameter rather
  than reading `lib/server-info.js`'s fixed `_repoRoot`, so whichever directory #1672 makes the
  serving install, only the argument changes. | MED impact | PM can reorder to put #1672 first]
- [ASSUMPTION: one origin observation per repo, in memory, not persisted. It replaces
  `behind-origin`'s separate fetch rather than adding a third remote read beside it and
  `update-checker`'s `ls-remote`. | MED impact | Architect can override] **As built in Chunk 01,
  this is narrower:** one observation per server process, for the live install only, held in
  `lib/behind-origin.js` and fixed to `REPO_ROOT`. Nothing yet observes another checkout's origin
  or shares an observation between clones. **Chunk 03 must build that generalization.** It needs
  an observation keyed by normalized origin URL, taking the repo root as a parameter. It must not
  assume one already exists.

**What would raise confidence:** one PM/Architect reply on the two HIGH assumptions. Neither needs a
spike.

## What exists today (inventoried 2026-09-21, HEAD `a3155b7c7`)

- `lib/server-info.js`: the runtime-vs-disk SHA check. `startupSha`, `currentDiskSha`, three-state
  `isStale`, `commitsAhead`. Its own docstring names the #993 gap: it never reads `git status`. The
  repo root is fixed to the server's own directory.
- `lib/behind-origin.js` drives the blue "N new commits upstream" banner. It fetches origin every
  15 minutes and returns only a *behind* count. **It skips a detached HEAD and collapses every
  failure to `0`.** #1678 forbids that failure mode ("never an unqualified up-to-date"). *Corrected
  during Chunk 01:* rev 1 said the live checkout was detached at an arbitrary commit with the banner
  silent. A read-only check found it detached exactly at release tag `v5.29.0`, which equals
  origin/main. That is the self-updater's healthy state, and staying silent there is right. The
  gap is real for a HEAD detached at a commit that is *not* a release tag, which Chunk 01 now
  observes.
- [DECISION: a HEAD detached exactly at a release tag is **not** a finding, even though #993 asks
  to warn when the checkout "is not on main" | every non-developer install sits there by design
  (the self-updater's path), so warning would fire permanently on healthy installs and teach
  operators to ignore the banner. A detached HEAD off a tag is still a warning | PM/operator can
  veto]
- `lib/git.js` `getInfo` already runs `git status --porcelain=v1 --branch`, but discards the
  `[ahead N, behind M]` counts and does not separate untracked files from modified ones.
- The launch preflight (`lib/launch-preflight*.js`) compares HEAD against the *handoff*, not
  against origin. The prime's `state` step has a cached, no-spawn CI line (`lib/ci-status.js`),
  which is the pattern to copy.
- The session page never calls `/api/server-info`. The session banner shows no branch or SHA.
- `lib/update-checker.js` runs a second, separate remote read (`git ls-remote`, tags).

## Design in one paragraph

A new `lib/checkout-freshness.js` computes a **checkout snapshot** for any repo root: branch or
detached, HEAD SHA, tracked-dirty and untracked counts, unpushed commits, and ahead/behind/diverged
against an **origin observation**. The observation carries origin/main's SHA, `checkedAt` and an
evidence state: `fresh` / `cached` / `stale` / `unavailable` / `no-remote`. There is one observation
per normalized origin URL and it is shared by every checkout of that repo, so two clones read the
same upstream target. The live-install snapshot adds the runtime SHA, and a **delta
classification** of what changed between runtime and disk: `executable`, `records-only`, `mixed` or
`unknown`, where any unrecognized path counts as executable. Every surface renders from this one
snapshot: the dashboard banner, the session banner, the prime `state` line and `tc`. None of them
computes its own. No read ever reports "current" without a fresh observation.

## Status

- [x] Chunk 01: Live-install checkout snapshot, honest origin observation, dashboard + prime (#993)
- [ ] Chunk 02: Classify what changed: executable vs records-only (#1678, refinement comment)
- [ ] Chunk 03: Per-session checkout facts in every session banner and launch (#1678)
- [ ] Chunk 04: Related-session coordination view for the PM (#1678)
- [ ] Chunk 05: Hard freshness gate on mutating workflows (car acceptance; UNSCOPED pending ruling)
Context: Chunk 01 was built, then reviewed by the Critic: 1 blocking finding and 6 warnings, all
fixed, and verify-resolutions came back clean. It shipped on `feat/993-checkout-freshness`.
Next: Chunk 02 (delta classification), but only once the PM authorizes it by name. Chunk 03 must
first generalize the origin observation, which is currently per-process and fixed to the live
install. Chunk 05 is unscoped until a ruling. VRF-993-live-checkout-banner (a check on a phone) is
pending with the operator.

## Build Chunks

### Chunk 01: Live-install checkout snapshot, honest origin observation, dashboard + prime

- **Issues:** #993 (all three expected items); the shared-observation half of #1678.
- **Description:** The thin vertical slice. It builds the snapshot module for the serving checkout
  and replaces `behind-origin`'s count with an honest observation. The result appears on
  `/api/server-info`, in the dashboard banner and on the prime `state` step. It proves one snapshot
  feeds every surface before the per-session widening.
- **Depends on:** none
- **Deliverables** (as built; the rev 1 wording planned the observation inside the new module
  instead):
  - New `lib/checkout-freshness.js`. It holds the local facts for any repo root: branch or
    detached, HEAD, release tag, upstream ahead/behind, tracked-change and untracked counts. These
    come from `status --porcelain=v1 --branch`, read with `GIT_OPTIONAL_LOCKS=0`, cached for 30
    seconds and single-flight. It also holds `assess(local, origin)`, which produces the findings
    and one sentence per finding; `snapshot`, `primeLines` and `isLiveInstall`; and
    `liveInstallSnapshot`, the single call every live-install surface makes.
  - `lib/behind-origin.js` owns the origin observation. `observation()` returns origin/main's SHA,
    the HEAD it was measured against, ahead/behind/relation, `checkedAt` and the evidence state.
    It reuses the legacy count's fetch, so a refresh still makes one call to origin. A HEAD
    detached off a release tag is now observed. **The legacy `snapshot()` payload and its tests are
    unchanged**; they are pinned by `deepEqual` and still drive the existing blue banner. Keeping
    them rather than rewriting them was deliberate: the new facts are additive.
  - `/api/server-info` gains `checkout`, recorded in the api-contract.
  - `#liveCheckoutBanner` on the dashboard, built with `textContent`.
  - The prime's `state` step and `tc whoami` (the verb question is settled: `whoami`, not a new
    verb) both print `primeLines`, for the live install's own project only.
  - Docs: `FEATURES.md`, `docs/configuration-reference.md`, and the `lib/server-info.js`
    docstring.
- **Tests:** the new `test/checkout-freshness.test.js` reads real temp repos with a bare origin:
  clean on main, a feature branch with unpushed commits, tracked vs untracked, detached off and on
  a tag, no-git, a failed read, and a read-only guarantee (the index bytes are unchanged). It also
  covers every evidence state in `assess`, the cache, `primeLines` and `isLiveInstall`, plus the
  banner renderer lifted from `landing.js`. `behind-origin.test.js` gains the observation suite,
  including one fetch per refresh, no fetch at a release tag, and redaction. `api-system` covers
  the `checkout` block reading `unknown` under the test runner. `api-plan-docs` checks that a
  non-live project gets no `liveInstall`. `sessions` checks the prime lines appear for the live
  install only, and `tc-verbs` checks the whoami rendering.
- **Acceptance criteria:** each of #993's 2026-08-18 conditions gets its own named line in the
  dashboard banner and the prime: feature branch, unpushed commits and untracked files. A HEAD
  detached off a release tag gets a line. With origin unreachable, no surface says current.
- **Visual change:** yes. Check the banner at 320–375px on the phone, and confirm it names the state
  in text, not color alone.
- **Done when:**
  1. The acceptance criteria are met and `node --test` passes (confirmed with a TAP run).
  2. `/prawduct:critic` has run and its blocking findings are resolved.
  3. It is committed, the chunk is marked `[x]`, and the handoff is written.

### Chunk 02: Classify what changed: executable vs records-only

- **Issues:** #1678 (the "reason, not just a delta" refinement).
- **Description:** Classify `startupSha..currentDiskSha` (runtime vs disk) and `HEAD..origin/main`
  by path. `server.js`, `lib/**`, `public/**`, `bin/**`, `deploy/**`, `version.json` and any
  unrecognized path count as `executable`. Docs, plans, `CHANGELOG.md`, ADRs, `.tangleclaw/**` and
  `.prawduct/**` count as `records-only`. A mix counts as `mixed`, and a failed diff is `unknown`,
  which is **never** downgraded to records-only. The stale-server banner then says "2 commits
  ahead, records-only — no restart needed" instead of an unqualified warning.
- **Depends on:** Chunk 01
- **Deliverables:**
  - `classifyDelta(repoRoot, fromSha, toSha)` in `lib/checkout-freshness.js`, with the path list
    in one exported constant.
  - An additive `deltaClass` field on the server-info payload and the `checkout` block.
  - Banner copy in `public/landing.js` for all four classes.
  - A docs row in `FEATURES.md`.
- **Tests:** each class against real temp repos. A new top-level directory classifies as
  `executable`. A diff failure classifies as `unknown`, and `unknown` renders as needing attention.
- **Acceptance criteria:** Replaying the 2026-09-20 case (`d0124256d..7e25288c5`, the roadmap
  board plus ADR 0002) classifies as `records-only`. Any `public/` change classifies as
  `executable`.
- **Critic mode:** chunk
- **Done when:**
  1. The acceptance criteria are met and tests pass.
  2. `/prawduct:critic` has run and its blocking findings are resolved.
  3. It is committed and the chunk is marked `[x]`.

### Chunk 03: Per-session checkout facts in every session banner and launch

- **Issues:** #1678 (the per-session banner, runtime-vs-checkout distinction and no-remote case).
- **Description:** Each session gets a snapshot of **its own** checkout: the pane's worktree when
  it is in one (via `wrap-scope.resolveWorkTree`), otherwise `project.path`. The snapshot reads the
  shared origin observation from 01, so every checkout of one repo shows the same upstream SHA and
  `checkedAt`. A feature worktree that is ahead of and behind main shows as `diverged`, not as
  wrong. For a TangleClaw session, the banner also shows the running server's SHA when it differs
  from that session's checkout. A project with no remote shows `no-remote`, never an origin
  comparison. **Prerequisite this chunk builds:** Chunk 01's observation is per-process and fixed
  to the live install, so this chunk first generalizes it into an observation keyed by normalized
  origin URL, with a repo-root parameter, a single-flight fetch per URL and the same evidence
  states.
- **Depends on:** Chunk 01 (Chunk 02 for the class label)
- **Deliverables:**
  - A per-session `checkout` field on the session-status payload.
  - A compact line in the `public/session.html` / `public/session.js` banner. On phone it is a
    single tappable line that expands to the details.
  - The prime `state` line now describes the session's own checkout.
  - New structural context: the per-session probe is a new git spawn per session page. It gets a
    time budget and a cache the way `git.getInfo` does. The cross-cutting concerns (error naming,
    degrade-not-crash, log names only) are addressed in the chunk's commit.
- **Tests:** two independent clones plus one linked worktree against one bare origin. All three
  report the same `originMainSha` and `checkedAt`, and each keeps its own branch/dirty state. A
  no-remote project gets `no-remote`. A running SHA older than disk stays visibly old after the
  disk is advanced.
- **Acceptance criteria:** #1678's acceptance examples 1–4 and 6 pass as tests. Example 5
  ("dirty work is preserved") holds by construction, since nothing in this car writes, and a test
  asserts that the snapshot is read-only (the porcelain status is unchanged before and after).
- **Visual change:** yes. Check the session banner at 320px.
- **Done when:**
  1. The acceptance criteria are met and tests pass.
  2. `/prawduct:critic` has run and its blocking findings are resolved.
  3. It is committed and the chunk is marked `[x]`.

### Chunk 04: Related-session coordination view for the PM

- **Issues:** #1678 (related sessions, checkout owner, explicit relationships for no-remote
  sessions).
- **Description:** Group live sessions by normalized origin URL, plus explicit project-group
  membership. The grouping is served as one read-only route, and `tc` renders it for the PM: each
  related session's owner (project and workspace), checkout path, branch/SHA, relation to the
  shared origin/main, dirty/untracked counts and delta class. The Architect appears through its
  explicit group with the related repo's shared status, labelled as the related repo's status and
  not its own. Unrelated no-remote projects are never grouped.
- **Depends on:** Chunk 03
- **Deliverables:**
  - New route `GET /api/freshness/related?project=<name>`, recorded in api-contract (additive; the
    error model follows the existing `{error, code}` shape).
  - A `tc freshness --related` rendering.
  - The runbook line in `docs/runbooks/stand-up-a-new-agent-fleet.md` updated.
- **Tests:** grouping by URL across `https`/`ssh` spellings of the same remote. Explicit-group
  membership for a no-remote project. Two no-remote unrelated projects are not grouped. The route
  test uses `store._setBasePath`.
- **Acceptance criteria:** This meets the car gate. The operator (dashboard), the PM (`tc
  freshness --related`), the Builders (session banner + prime) and the controller (`/api/...`) all
  render the same origin SHA, `checkedAt` and per-checkout facts from one snapshot.
- **Done when:**
  1. The acceptance criteria are met and tests pass.
  2. `/prawduct:critic` has run and its blocking findings are resolved.
  3. It is committed and the chunk is marked `[x]`.

### Chunk 05: Hard freshness gate on mutating workflows

- **Issues:** car A1 acceptance (PM ruling 2026-09-21); no issue filed yet. File one once it is scoped.
- **Description:** UNSCOPED. Needs a ruling on (1) which workflows are blocked (wrap, PR merge,
  server restart?), (2) which conditions block them (unavailable evidence, a live checkout that is
  not on main or is dirty, an executable delta?), and (3) who can override. The block refuses the
  mutating action. It never refuses to serve.
- **Depends on:** Chunk 04
- **Type:** cumulative-final
- **Done when:** scoped by ruling, then the standard cycle, with the cumulative Critic.

## Governance Checkpoints

- **After Chunk 01:** confirm that the one-snapshot architecture holds, i.e. that no surface still
  computes its own freshness, before widening to per-session probes.
- **After Chunk 03:** re-check #1672's status. If the serving install has moved, re-point the
  live-install snapshot's root before 04.
- **After Chunk 05 (cumulative):** the car gate is demonstrated live on real sessions, not only in
  fixtures.

**Cadence:** one chunk per session, each with its own PR. The PM authorizes each chunk by name.

## Out of scope (named so nothing is silently dropped)

- Pulling, fast-forwarding, restarting and stashing are all #1710's job, and none happen here.
- Relocating the runtime is #1672.
- Refusing to serve or blocking a workflow on freshness would be a separate ruling (see the HIGH
  assumption above).

## Revision log

- **rev 1** (2026-09-21): first draft for PM traceability review.
- **rev 2** (2026-09-21): the PM verified traceability, confirmed the related-sessions rule, ruled the
  hard block into car acceptance (new Chunk 05, unscoped), and authorized Chunk 01. The
  cumulative-final marker moves from 04 to 05.
