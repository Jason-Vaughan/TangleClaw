---
artifact: build-plan
version: 2
scope: fix-891-git-budget
depends_on:
  - artifact: architecture
  - artifact: boundary-patterns
  - artifact: observability-strategy
governed_by:
  - artifact: architecture
    dispositions:
      - "a dependency's failure degrades TangleClaw, never crashes it → conforms; this plan replaces a kill with a labelled partial"
  - artifact: boundary-patterns
    dispositions:
      - "a failure crossing a contract surface carries a machine-readable code so the consumer never pattern-matches on message text → conforms; `incomplete` names fields, it is not prose"
  - artifact: observability-strategy
    dispositions:
      - "logs carry names, never payloads → conforms; the budget warning names the directory and the fields it could not establish"
      - "every logged error says what failed, why, and what the operator can do → PARTIAL, and deliberately so. The warning says what failed (the named fields) and why (the budget ran out); it offers no remedy because there is none the operator can act on — the repository is slow, not misconfigured, and the previous behaviour's remedy (grant Full Disk Access) was the misdiagnosis this change removes. Inventing an action to satisfy the norm would restore the defect. Logged at warn once per directory then debug, because the read repeats every poll."
---

# Build plan — #891: bound git's total work, so the deadline can only expire on a path that never answers

## Problem

`PROJECT_FACTS_TIMEOUT_MS` is 5000ms and bounds one round trip to the scanner child.
`git.getInfo` → `_fetchInfo` behind it issues **seven** `execSync` spawns, each independently
capped at 5000ms by `lib/git.js:19`:

| # | command | via |
|---|---|---|
| 1 | `git rev-parse --is-inside-work-tree` | `isGitRepo` |
| 2 | `git rev-parse --abbrev-ref HEAD` | `_getBranch` |
| 3 | `git status --porcelain` | `_isDirty` |
| 4 | `git rev-parse HEAD` | the has-commits probe |
| 5 | `git log -1 --format=%s` | `_getLastCommitMessage` |
| 6 | `git log -1 --format=%cr` | `_getLastCommitAge` |
| 7 | `git describe --tags --abbrev=0` | `_getLatestTag` |

An honest worst case near **35s** against one deadline of **5s**. The supervisor SIGKILLs the
child, `readProjectFacts` degrades with `SCAN_TIMEOUT`, and the operator is handed a Full Disk
Access remedy for a permission that was never the problem. It then self-sustains: the kill
discards `git.getInfo`'s in-child cache, so the retry after the backoff is equally cold.

**Measured, not assumed.** All seven spawns against this repository (949 commits, 400 tracked
files), warm: **84.5ms total**, no single command above 20ms. So the 5s deadline has ~59× headroom
on a healthy repository, and the failure is a **stall** case — a very large repository with a cold
page cache, or a network//Users-under-TCC filesystem — not an "any large repo" case. The issue's
own wording ("a large or cold repo") is looser than the evidence supports and this plan says so.

That does not make it theoretical: `git status --porcelain` is the spawn with unbounded work in it,
and the whole point of the scanner child is the filesystem that does not answer.

## Confidence check

1. **Problem:** a project whose git work legitimately exceeds the deadline gets its scanner child
   killed and is reported as a permissions failure it does not have.
2. **Success:** `PROJECT_FACTS_TIMEOUT_MS` expiring means "this path did not answer", never "this
   repository was slow". A slow-but-healthy repository renders, with any field the budget could not
   establish **named as unestablished** rather than defaulted.
3. **Out of scope:** #885 (rendering any of this to the operator), #890 (the `execSync` pair in
   `enrichProject`), #889 (the wider synchronous-read family), and collapsing the seven spawns into
   three — see "Deliberately not done" below.

**Requirements confidence: High.** The mechanism was read before it was tuned, the arithmetic is
verified against the source, and the healthy-case cost is measured rather than recalled.

## Design

### The budget goes in `lib/git.js`, not in the handler

The issue says "bound git's total work inside the handler". Putting it in `_fetchInfo` instead is
strictly better and the call-site census is why: `_gitInfo` is called from **three** places in
`lib/dir-scanner-child.js` — `projectFacts`, `listUnregistered` and `scanEntries` — and the latter
two call it **once per candidate subdirectory in a loop**. Those loops
already carry their own `deadlineAt`, but a deadline checked *between* iterations cannot interrupt a
synchronous 35s spawn inside one, so today a single stalled repository blows through a budget the
code documents as bounding the whole walk. A budget in the `projectFacts` handler would fix one call
site and leave the two documented ones lying.

**A budget in `_fetchInfo` is necessary but NOT sufficient, and the first implementation stopped at
necessary** — caught by the Critic (R-2/R-8). `_gitInfo` called `git.getInfo(dir)` with no options,
so each candidate took a fresh FULL budget regardless of how little of the walk remained: the overrun
fell from ~35s to ~4s and did not go away, while the plan and commit message both claimed all three
sites were fixed. The walk call sites now pass `deadlineAt - Date.now()`, which is what makes the
walk's own bound enforced rather than documented. Guarded by a source-level assertion, because the
overrun is a property of what the call site passes and nothing git returns can reveal it.

### Exhaustion degrades to a labelled partial — never to `null`, never to a default

Two consumers make this non-negotiable, both found by grepping rather than assumed:

- **`lib/dir-scanner-child.js`, the `scanEntries` handler** — `detected: !!((gitInfo && gitInfo.branch) || hasTangleclawConfig || hasProjectMarker)`.
  Returning `null` on exhaustion would make a real, git-only project **absent from the detected
  list**. A slow repository would silently stop being a project.
- **`public/ui.js:115` and `:187`** — `project.git.dirty ? '<dot>' : ''`, and `public/setup.js:584`
  the same. `_isDirty`'s catch already returns `false`, so a check the budget skipped would render a
  **dirty repository as clean**. That is an unknown falling through to a definite — the #861 shape,
  and the reason #885 exists one layer up.
- **`public/ui.js:248`** — `project.git ? … : 'Not a git repo'`. `null` on exhaustion would print a
  flatly false statement.

So `_fetchInfo` gains `incomplete: string[]`, naming the fields it did not establish (`[]` in the
normal case), and a skipped `dirty` becomes `null` rather than `false`. Additive: no existing
consumer breaks, and #885 gets a seam to render — the same seam-not-feature split #884 used.

### The deadline is derived from the budget, not set beside it

`PROJECT_FACTS_TIMEOUT_MS = GIT_INFO_BUDGET_MS + FILE_WORK_MARGIN_MS`, computed in code. Two numbers
that must agree and are maintained separately will drift; this makes drift unrepresentable rather
than documented. Prefer an invariant to a tally.

**The chosen budget keeps the deadline where it already is.** `GIT_INFO_BUDGET_MS = 4000` plus a
1000ms margin for the governance read, the config parse and the version chain's up-to-four
root-level file reads gives `PROJECT_FACTS_TIMEOUT_MS = 5000` — **unchanged**. This matters: the poll
issues these one at a time, so raising the per-project deadline would multiply across N projects on a
ten-second poll. The fix costs no aggregate latency; it only makes the existing 5s honest.

4000ms is ~47× the measured warm cost of all seven spawns.

### Partial results are not cached

`getInfo`'s 2-minute TTL over a truncated answer would freeze a bad reading across twelve polls of a
repository that may be fine now. Complete results cache as today; partials are returned and dropped.

## Chunks

### Chunk 01: The budget, the labelled partial, and the derived deadline

- **Description:** `_fetchInfo(dir, { budgetMs })` tracks one deadline across all seven spawns; each
  `_exec` gets `Math.min(PER_CALL_CAP_MS, remaining)`; a step with no remaining budget is **skipped,
  not attempted**, and named in `incomplete`. `dirty` becomes `null` when skipped. `getInfo` caches
  only complete results and passes the budget through. `PROJECT_FACTS_TIMEOUT_MS` is derived from
  `GIT_INFO_BUDGET_MS`.
- **Deliverables:** `lib/git.js`, `lib/project-facts.js`, `.prawduct/artifacts/boundary-patterns.md`
  (the `incomplete` field on the git contract), `test/git-budget.test.js` (new — kept separate from
  `test/git.test.js`, which stays the unbudgeted behaviour's file)
- **Tests** — each named with the mutation it must catch:
  1. Total wall clock of `_fetchInfo` stays within the budget when every spawn stalls.
     *Mutation:* restore the per-call cap as the only bound → must go red.
  2. A skipped `dirty` is `null` and named in `incomplete`.
     *Mutation:* let it fall through to `_isDirty`'s `false` → must go red. This is the false-fact
     guard and the most important one here.
  3. `incomplete` is `[]` and every field is established on a healthy repository.
     *Mutation:* mark a field incomplete unconditionally → must go red.
  4. A partial result is not cached — a second call re-reads.
     *Mutation:* cache partials → must go red on the second call's identity.
  5. `PROJECT_FACTS_TIMEOUT_MS > GIT_INFO_BUDGET_MS`, asserted structurally.
     *Mutation:* raise the budget past the deadline → must go red.
  6. `detected` stays true for a git-only project whose info came back partial (the `:362`
     regression). *Mutation:* return `null` on exhaustion → must go red.
- **Acceptance criteria:** no single call to `git.getInfo` can exceed `GIT_INFO_BUDGET_MS` of
  wall clock; `PROJECT_FACTS_TIMEOUT_MS` is not a literal; suite green.
- **Done when:** 1. criteria met and tests pass · 2. `/prawduct:critic` run and blocking findings
  resolved · 3. committed and recorded in the change-log

## Deliberately not done

**Collapsing seven spawns into three.** `git status --porcelain=v1 --branch` answers branch *and*
dirty *and* is-a-repo in one spawn; `git log -1 --format=%s%n%cr` answers message *and* age *and*
has-commits in one. That is 7 → 3, which would cut the worst case to 15s and the healthy-case spawn
overhead by more than half — a genuine improvement that this plan does **not** make, because it
rewrites parsing with real edge cases (detached HEAD, `## HEAD (no branch)`, an empty repository, a
repository with no upstream) and deserves its own tests and its own review rather than riding in on a
deadline fix. To be filed as its own issue.

## Verification strategy

1. **Unit** — the six guards above, each mutation-confirmed: plant the reversion, watch it go red.
   A guard that has not been watched to fail has not been verified (#893).
2. **Fixture hygiene** — new git fixtures must not use bare `git init`: #831 records that it
   inherits the live global template dir and flakes when TangleClaw rewrites it. Set an empty
   `--template=`.
3. **Live — RUN 2026-08-09, result recorded.** `readProjectFacts` against this repository (949
   commits, 400 tracked files) through the real forked child: **139ms**, `exists: true`,
   `branch=fix/891-git-work-budget`, `dirty=true` (correct — the tree was dirty), `version=4.38.0`,
   **`incomplete: []`**, no `unreadable`/`unreadableCode`. A missing directory returned in 0ms with
   `git: null` and no spurious remedy. `PROJECT_FACTS_TIMEOUT_MS` printed as 5000, derived from
   `GIT_INFO_BUDGET_MS` 4000. The healthy path is unchanged and the deadline is where it was.
4. **Not verifiable here, and stated as such:** the actual stall case needs a repository whose git
   work genuinely exceeds 4s. A stubbed `_exec` proves the budget arithmetic, not that git stalls the
   way the issue describes. The unrun TCC probe (a launchd process without Full Disk Access) remains
   the honest gap under this whole family.

## Status

- [x] Chunk 01: The budget, the labelled partial, and the derived deadline
