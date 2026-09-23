---
title: "Train A Car A4: exact release proof and workflow supply-chain floor"
status: Chunk 01 REVIEWED 2026-09-23 — Critic clean, Architect ruled A1–A5 (message ecc27e3b); Operator approved the CI change in-pane; PR open, merge on the Operator's go
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-23 (message 9d88259b). Workflow (CI) changes: the Operator gave a direct in-pane go for Chunk 01 on 2026-09-23 (project rule: only the Operator authorizes CI changes). The merge also waits on the Operator
issues: [1436, 1551]
governed_by:
  - Architect roadmap, "Car A4 — exact release proof and workflow supply-chain floor" (TangleClaw-Architect/.tangleclaw/plans/v5-v6-backlog-census-and-bridge-roadmap.md)
  - train manifest `.tangleclaw/plans/v5-bridge-train-manifest.json`, car A4 acceptance gate
  - ADR 0014 and docs/dependency-bump-audit.md (Dependabot bumps are audited and rebuilt, never merged)
  - project rule: Train chunks of at most 3–4 issues, one chunk per session
scope: train-a-car-a4
branch: fix/a4-chunk1-action-pins
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

Outline only; planned in full at its own plan-written boundary. Refuse when the tag's dereferenced
commit is not `GITHUB_SHA`, including a pre-existing tag being healed. Gate publishing on a
successful `test` run for that exact SHA. Scope the write token to the publishing job (A3). Add
tests for both refusals. The mechanism for waiting on the test result is the main decision to take
to the Architect: `workflow_run`, polling check-runs for `GITHUB_SHA`, or making release a
`needs: test` job.

Bookkeeping when Chunk 02 starts: repoint the frontmatter `branch:` at Chunk 02's branch and
rewrite `status:`, because both still describe Chunk 01's merged and deleted branch.

## Status

- [x] Chunk 01: Every workflow dependency is pinned to an immutable commit, and a test enforces it (#1436): Critic rev-20260923T191930Z (1 blocking) resolved by rev-20260923T192644Z (0 findings); Architect ruled A1–A5 (A2/A4 MODIFY); follow-up #1827
- [ ] Chunk 02: A release publishes only the exact commit that was tested, and its tag dereferences to it (#1551)
