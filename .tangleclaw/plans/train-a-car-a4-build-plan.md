---
title: "Train A Car A4: exact release proof and workflow supply-chain floor"
status: Chunk 01 SHIPPED (PR #1828). Chunk 02 PLAN WRITTEN 2026-09-23. B1–B5 sent to the Architect, and the build proceeds on the recommendations meanwhile. The PR waits on the rulings and merges on the Operator's direct go
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-23 (message 9d88259b). Workflow (CI) changes: the Operator gave a direct in-pane go for Chunk 01 on 2026-09-23 (project rule: only the Operator authorizes CI changes). The merge also waits on the Operator. Chunk 02: the PM dispatched it via Medusa, 2026-09-23 (message 63de80dc). Its CI change and merge still need the Operator's direct go
issues: [1436, 1551]
governed_by:
  - Architect roadmap, "Car A4 — exact release proof and workflow supply-chain floor" (TangleClaw-Architect/.tangleclaw/plans/v5-v6-backlog-census-and-bridge-roadmap.md)
  - train manifest `.tangleclaw/plans/v5-bridge-train-manifest.json`, car A4 acceptance gate
  - ADR 0014 and docs/dependency-bump-audit.md (Dependabot bumps are audited and rebuilt, never merged)
  - project rule: Train chunks of at most 3–4 issues, one chunk per session
scope: train-a-car-a4
branch: fix/1551-release-exact-sha
partition: serial. Both chunks edit .github/workflows/release.yml
critic_mode: chunk per chunk, cumulative at the last chunk
---

# Train A Car A4: exact release proof and workflow supply-chain floor

**Acceptance gate (manifest):** a release cannot publish unless the exact approved SHA was tested
and the tag dereferences to it. Privileged dependencies are immutable and mechanically checked.

## Chunks (car-level, ordered)

| # | Chunk | Issues | Why this order |
|---|---|---|---|
| 01 | Every workflow dependency is pinned to an immutable commit, and a test enforces it | #1436 | Chunk 02 rewrites `release.yml` and should build on pinned actions. It is also the smaller of the two, with no open design question in the issue itself. |
| 02 | A release publishes only the exact commit that was tested, and its tag dereferences to it | #1551 | It carries the car's main design choice: how the release waits for the test result on that exact SHA. That choice goes to the Architect at its own plan-written boundary. |

## Chunk 01: Every workflow dependency is pinned to an immutable commit (#1436)

### Confidence check

1. **Problem:** every `uses:` in `.github/workflows/` names a movable major tag (`@v7`). Someone
   who can move that tag upstream runs new code in our CI with no diff here, including in
   `release.yml`, which holds `contents: write` (audit H5; the `tj-actions` mechanism,
   CVE-2025-30066).
2. **Success:** every `uses:` is `owner/repo@<40-hex SHA> # vX.Y.Z`, and a suite test fails on any
   other form. CI behaves exactly as before, because each SHA is the commit the tag resolves to
   today. Dependabot bumps then arrive as SHA diffs that `scripts/check-bump-diff.js` already
   accepts.
3. **Out of scope:** the release tag-target and tested-SHA gate (Chunk 02, #1551); repository
   settings (Actions allow-list, server-side SHA-pinning policy, branch protection), which are
   Operator-only and are offered below as a recommendation, not built.

### Facts established while planning (verified 2026-09-23 at 7261f43)

- Six `uses:` lines across three workflows, all tag refs: actions/checkout@v7 and
  actions/setup-node@v7 in `release.yml`, `test.yml` and `upstream-drift.yml`. There are no
  local (`./`) or `docker://` actions.
- `git ls-remote` shows that actions/checkout tags v7 and v7.0.1 are both
  `3d3c42e5aac5ba805825da76410c181273ba90b1`, and that actions/setup-node tags v7 and v7.0.0 are
  both `820762786026740c76f36085b0efc47a31fe5020`. Both are lightweight tags on the same commit,
  so pinning changes no behavior.
- Repo Actions settings (read-only API): `default_workflow_permissions: read`,
  `allowed_actions: all`, `sha_pinning_required: false`. Branch protection on `main` requires
  only the `test` check.
- Workflow `permissions:` blocks: `release.yml` has `contents: write` at workflow level,
  `upstream-drift.yml` has `contents: read`, and `test.yml` has **none**, so it inherits the
  repo default. That default is read today; if someone flips it in settings, `test.yml` widens
  silently with no diff here.
- `scripts/check-bump-diff.js` (#1361) already accepts `@<sha> # vX.Y.Z` refs, so the Dependabot
  audit path needs no change.
- `setup-node` with `node-version: 22` resolves the newest 22.x at run time (v22.23.3 today), which
  means it downloads a Node binary chosen at run time. In `release.yml` that binary runs inside
  the `contents: write` job.
- Prose that goes stale after this chunk: the `docs/dependency-bump-audit.md` paragraph "Our
  workflows also reference actions by tag … tracked in #1436", and the `dependabot.yml` comment
  "The workflows reference actions by tag", plus the table row in the same doc.

### Architectural decisions (for the Architect; recommendation first)

- **A1: Pin scope, and which version the SHA names.** Recommended: pin **every** workflow, not only
  the privileged `release.yml`. Each pin is the full commit SHA that the current major tag
  resolves to, with the exact release tag that points at the same commit as its comment
  (`# v7.0.1`), so CI runs byte-identical code. Rejected: pinning `release.yml` alone.
  `test.yml`'s result gates every merge, so a hijacked action there can approve anything, and one
  uniform rule is simpler to enforce mechanically than an allow-list of exempt files.
- **A2: How pinning is mechanically checked.** Recommended: a suite test
  (`test/workflow-action-pins.test.js`) that reads every `.github/workflows/*.y{a,}ml` and fails
  on any `uses:` that is not `owner/repo[/path]@<40 lowercase hex>` followed by a `# vX.Y.Z`
  comment. It refuses `docker://` unless digest-pinned, and allows local `./` actions, which are
  reviewed in this repo. The test also cross-checks that the version comment agrees across
  workflows for the same SHA. It is in the required `test` check, so an unpinned ref cannot merge.
  **Also recommended, as an Operator decision:** turn on the repo's server-side
  `sha_pinning_required` setting as an independent second layer, because the test only guards
  what passes through CI. Rejected: a separate CI job for the check. A new check name is not
  required by branch protection, so `--auto` merges past it (the same reason the cache guard lives
  inside `test`).
- **A3: Least-privilege token, closing the silent-widening path.** Recommended: in this chunk, give
  `test.yml` an explicit top-level `permissions: contents: read`, and have the pin test also
  assert that every workflow declares a top-level `permissions:` block. Chunk 02, which rebuilds
  `release.yml`, moves `contents: write` from workflow level to only the job that tags and
  publishes. Rejected: relying on the repo default, which a settings change can widen invisibly.
- **A4: The transitive Node download in the privileged job.** Recommended: in `release.yml` only,
  pin `node-version` to an exact release (`22.23.3`), and have the test require an exact
  `X.Y.Z` there. `test.yml` and `upstream-drift.yml` keep `22`, because they hold no write token
  and should track patch releases. Rejected: (a) dropping `setup-node` from `release.yml` and
  using the runner image's Node, which is equally mutable and not pinned anywhere; (b) leaving it
  floating, which fails the acceptance gate's "privileged dependencies are immutable". Known
  limit, not closed here: the `ubuntu-latest` runner image is itself mutable. Pinning an image
  version trades that for an unsupported-image deadline. I recommend filing it rather than
  pinning.
- **A5: ADR 0014 status text (sent as an addendum).** ADR 0014 names #1436 as open in two
  places: the Dependabot exemption paragraph ("does not close a tag moved upstream … that is
  #1436") and the amendment's honest-limit list. Recommended: a factual status update in this PR.
  #1436's mechanism landed, and rule 7 still waits on #1551. No rule changes. Rejected: leaving
  the ADR stale until Chunk 02.

### Architect rulings (2026-09-23, message ecc27e3b): binding

- **A1: APPROVE.** Pin every remote action and reusable-workflow reference to the verified full
  SHA, annotated with the exact release tag.
- **A2: MODIFY.** The scanner stays inside the required `test` check and covers every `uses` form,
  at step and job level, with the key and the value quoted or unquoted:
  - remote refs require 40 lowercase hex;
  - docker refs require a digest;
  - local `./` refs are allowed.

  Annotation consistency is keyed by action identity/path plus SHA. The test must say honestly
  what it proves: syntax and local consistency, not that an annotation resolves to its SHA. The
  initial mapping is evidenced by the recorded `ls-remote`; future changes go through the bump
  audit. Recommend that the Operator enable `sha_pinning_required`, and record that GitHub's policy
  does not cover reusable-workflow tag refs (confirmed in GitHub's docs: "Reusable workflows can
  still be referenced by tag"), so it is a second layer, not a replacement.
- **A3: APPROVE.** Every workflow declares explicit top-level permissions, and `test.yml` is
  `contents: read`. The workflow-level `contents: write` in `release.yml` may remain only
  through this serial chunk, and must move to the publishing job in Chunk 02. Do not claim release
  least-privilege is complete before then.
- **A4: MODIFY.** Pin `node-version` to 22.23.3 and enforce exact X.Y.Z, but describe it as
  eliminating run-time version selection, not artifact immutability. `setup-node` still
  downloads without a workflow-pinned digest. The follow-up covers the whole mutable execution
  substrate (runner image plus Node artifact integrity and update policy): filed as #1827.
- **A5: APPROVE.** Make the two factual ADR 0014 status edits, saying "full commit SHA". No rule
  changes.
- Architecture approval does not authorize CI publication: the Operator's direct go is still
  required, and the PR must not auto-merge.

### Implementation calls (not architectural)

- The version comment is the exact tag (`v7.0.1`), matching Dependabot's rewrite format, so a
  bump PR is a one-line SHA+comment diff.
- The test parses lines with a regex, the way `check-bump-diff.js` does. It uses no YAML library,
  because the repo has zero npm dependencies.
- Docs: update the stale paragraph and table row in `docs/dependency-bump-audit.md` and the
  `dependabot.yml` comment in the same commit, and add a `CHANGELOG.md` `### Security` entry.

### Tests (written alongside)

- Every `uses:` in every workflow is SHA-pinned with a version comment. A fixture with `@v7`,
  `@main`, a short SHA, or a SHA with no comment fails. A local ./ path passes.
  `docker://img@sha256:<64hex>` passes and `docker://img:tag` fails.
- Every workflow declares a top-level `permissions:` block.
- `release.yml`'s `setup-node` `node-version` is an exact `X.Y.Z`.
- Mutation checks, watched red: revert one pin to `@v7`, delete `test.yml`'s permissions block,
  and set release `node-version` back to `22`. Each must turn its test red.

### Done when

- All pins land, the test is green, the docs are current, and the Critic is clean.
- The PR is **not** `--auto` (it touches CI). It merges on the Operator's go.

## Chunk 02: A release publishes only the exact commit that was tested (#1551)

### Confidence check

1. **Problem:** `release.yml` asks only whether tag `vX.Y.Z` *exists*. It never checks which commit
   the tag names, and it publishes without any test result for the commit it releases. The newest
   tag is the update path for every install, so a tag that names a different commit, or a commit
   no test ran on, delivers code no gate has seen (audit M6).
2. **Success:** a run publishes only when (a) the suite passed on `GITHUB_SHA` inside that same run,
   and (b) the tag dereferences to `GITHUB_SHA`, both before a pre-existing tag is healed and on
   origin after a push. Either mismatch fails the run red before anything is published. The write
   token exists only in the job that tags and publishes.
3. **Out of scope:** repository settings (tag protection rulesets, `sha_pinning_required`, branch
   protection), which are Operator-only. The mutable runner image and Node artifact (#1827).
   Train A's exit-gate item "release and deployment are explicitly initiated after the integration
   candidate is frozen" is a train-level question about whether releases stay automatic; this
   chunk does not change the trigger.

### Facts established while planning (verified 2026-09-23 at fbdf22c)

- `release.yml` has one job holding workflow-level `contents: write`. It computes the version,
  checks tag and Release existence independently, extracts notes, creates and pushes an annotated
  tag if missing, checks the tag is *visible* on origin, then publishes. Nothing compares any SHA.
- `test.yml` triggers on `pull_request` and on `push` to `main`/`v5-baseline`, with top-level
  `contents: read`. Its job is named `test`, the only check branch protection requires.
- GitHub semantics this design relies on (Actions docs, reusable workflows): a called workflow's
  `github` context is the caller's, so `github.sha` and `actions/checkout`'s default ref are the
  caller's `GITHUB_SHA`. A called workflow's token can only be narrowed, never widened, from the
  caller job's grant. A job with `needs:` and no status function in its `if:` is skipped when a
  needed job fails.
- `ls-remote` prints an annotated tag twice: `refs/tags/T` (the tag object) and `refs/tags/T^{}`
  (the commit). A lightweight tag prints only `refs/tags/T`, which is the commit. So the commit is
  the `^{}` line when it exists, else the plain line. `lib/update-checker.js#parseTagsOutput`
  answers a different question (which versions exist) and deliberately skips `^{}` lines, so it
  cannot be reused for this check.
- `docs/release-process.md` "If a release did not go out" tells the operator to heal by running
  `workflow_dispatch` from `main`. That runs at main's *current* head. Once a later commit lands,
  that head is no longer the tagged commit, so under this chunk's rule that dispatch must refuse.
  This procedure changes.
- Recent release runs are all `push` events; the last was 2026-09-20.

### Architectural decisions (for the Architect; recommendation first)

- **B1: How the release waits for tests on the exact SHA.** Recommended: **reusable workflow plus
  `needs:`.** `test.yml` gains `on: workflow_call`. `release.yml` gets a `test` job that
  calls `./.github/workflows/test.yml`, and the publishing job declares `needs: test`, with no
  `always()`, `!cancelled()` or `failure()` in its `if:`. The suite then runs on `GITHUB_SHA`
  inside the release run itself, so "tested" and "released" are the same SHA by construction,
  with no lookup and no waiting. Cost: a version-bump push runs the suite twice (about 7 min),
  and releases are rare. Rejected: (a) the `workflow_run` trigger. It runs the default branch's
  copy of `release.yml` and not the tested commit's, it loses the `version.json` path filter, and
  it attaches a write-token workflow to another workflow's completion, a known privileged-trigger
  hazard. (b) Polling the check-runs API for `GITHUB_SHA`. A check named `test` can be posted by
  any app with `checks: write` unless the poll pins the app and workflow identity, the poll needs a
  timeout that is a guess, and the run holds a runner while it waits.
- **B2: Tag-target rule, including heal and the already-released case.** Recommended: the tag's
  dereferenced commit must equal `GITHUB_SHA` (1) before anything, when the tag already exists and
  its Release does not (the heal path), and (2) after the push, replacing today's "is visible"
  check with "is visible **and** dereferences to `GITHUB_SHA`". A mismatch fails red with both
  SHAs named. When the tag **and** Release both already exist, the run publishes nothing. There it
  emits a `::warning` naming a mismatch and stays green, rather than failing a run that changes
  nothing (e.g. a later `version.json` edit that keeps the version). Also: the checkout's `HEAD`
  must equal `GITHUB_SHA`. Rejected: failing the fully-released case red, which adds noise with no
  protective effect; moving or deleting a mismatched tag automatically, which is data deletion and
  Operator-only.
- **B3: Token scope (completing A3).** Recommended: top-level `permissions: contents: read`, the
  called `test` job read-only, and `contents: write` only on the publishing job. Rejected: an extra
  read-only "plan" job ahead of it. The publishing job is the only one left, so splitting it again
  adds output-plumbing for no narrower grant.
- **B4: Operator procedure change (`docs/release-process.md`).** Recommended: heal a partial release
  with **Re-run jobs** on the original run, which keeps its `GITHUB_SHA`. `workflow_dispatch` from
  `main` remains valid only while main's head is still the tagged commit, and otherwise it now
  refuses by design. Document that a refusal means "do not move the tag by hand; ask the Operator".
  Rejected: a dispatch input naming the SHA to release, which reopens exactly the choice this chunk
  removes.
- **B5: New module.** The dereference rule becomes a pure function plus a small CLI,
  `scripts/release-tag-gate.js`, which the workflow calls and the suite unit-tests. Recommended as
  an implementation call. Listed here because it adds a module to the release path.

### Implementation calls (not architectural)

- The CLI reads `ls-remote` output on stdin, takes the tag and the expected SHA as arguments, and
  exits non-zero with a `::error::` line on a mismatch or on output it cannot parse. It fails
  closed: no line for the tag counts as "absent", and anything malformed is an error, never
  "absent".
- The existing "Verify the tag is visible on origin" step becomes the post-push dereference check.
  It keeps its independent `ls-remote` and its explicit exit-status capture.
- Comments in `release.yml` and `test.yml` say why `workflow_call` exists, so nobody removes it
  as unused.

### Tests (written alongside)

- `test/release-tag-gate.test.js` (unit): an annotated tag resolves through `^{}`; a lightweight
  tag resolves through its plain line; a mismatch refuses and names both SHAs; an absent tag reads
  as absent; malformed or ambiguous output (two plain lines for one tag) is an error, not "absent";
  `refs/tags/v1.2.30` does not satisfy a lookup for `v1.2.3`; CLI exit codes for each.
- `test/release-workflow.test.js` (source pins, the `ci-workflow.test.js` pattern):
  - the test-before-publish refusal: `release.yml` has a job that `uses: ./.github/workflows/test.yml`;
    the publishing job `needs:` it and has no status function in its `if:`; `test.yml` declares
    `workflow_call`.
  - the tag-target refusal: the dereference check runs before the tag push and before the
    publish step, and the post-push check calls the gate with `GITHUB_SHA`.
  - token scope: top-level permissions are read-only, and only the publishing job holds
    `contents: write`.
- Mutation checks, watched red: drop `needs: test`; add `always()` to the publishing `if:`; remove
  `workflow_call`; swap the gate's expected SHA; hoist `contents: write` back to the top level.
- Honest limit: source pins show what the file says, not what GitHub runs. The live proof is the
  first release run after merge (or a dispatch from `main` when the version is already fully
  released, which exercises the test job and the gate and publishes nothing). That run is for the
  Operator to start.

### Done when

- The gate module and the workflow changes land, both test files are green, the mutation checks
  are watched red, `docs/release-process.md` and `CHANGELOG.md` are current, the Architect has ruled
  on B1–B5, and the Critic (cumulative, last chunk of the car) is clean.
- The PR is **not** `--auto` (it touches CI). It merges on the Operator's direct go.

## Status

- [x] Chunk 01: Every workflow dependency is pinned to an immutable commit, and a test enforces it (#1436): Critic rev-20260923T191930Z (1 blocking) resolved by rev-20260923T192644Z (0 findings); Architect ruled A1–A5 (A2/A4 MODIFY); follow-up #1827
- [ ] Chunk 02: A release publishes only the exact commit that was tested, and its tag dereferences to it (#1551)
