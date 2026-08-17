---
artifact: build-plan
version: 2
scope: git-spawn-collapse-895
depends_on:
  - artifact: architecture
governed_by:
  - artifact: security-model
    dispositions:
      - "secure by default, opt-out not opt-in → inapplicable because no auth, ingress, or bind surface is touched"
last_validated: 2026-08-12
---

# Build Plan — collapse `git.getInfo`'s seven spawns (#895)

Reads one repository's state in three `git` invocations instead of seven, without
changing what a caller is told — including what it is told when the read fails.

## Confidence Check

**What problem are we solving?** `lib/git.js` `_fetchInfo` runs seven `git`
invocations to answer five questions, and #891 has to bound all seven under one
4000ms budget that must also fit inside the scanner child's 5s deadline.

**What does success look like?** A healthy repository with commits is read in
**three** invocations; the `incomplete`/budget semantics from #891 are unchanged;
and a repository that is merely BROKEN still reports as a project rather than
disappearing from the dashboard.

**What's out of scope?** Changing the budget, the cache TTL, or anything about
how `getInfo`'s answer is rendered (#885). No new fields.

## The probe this plan is built on

Design here is measured, not recalled — every claim below came from running the
commands against real fixture repositories (`git init --template=`, #831):

| state | `git status --porcelain=v1 --branch` | exit |
|---|---|---|
| clean, no upstream | `## main` | 0 |
| tracking upstream | `## main...origin/main` | 0 |
| ahead | `## main...origin/main [ahead 1]` | 0 |
| dirty | `## main` + `?? b.txt` | 0 |
| detached HEAD | `## HEAD (no branch)` | 0 |
| **unborn HEAD (fresh init)** | `## No commits yet on main` | **0** |
| not a repository | `fatal: not a git repository…` | 128 |

Four findings that shape the design:

1. **An unborn HEAD does not fail `status`** — it reports exit 0 and names the
   branch. Today `rev-parse --abbrev-ref HEAD` *fails* there (exit 128) and the
   code answers `'unknown'`. So a freshly-initialised project gains its real
   branch name. That is a deliberate improvement, called out because it is a
   behavior change, not a silent one.
2. **`...` cannot appear in a branch name.** `git branch 'has...dots'` is refused
   — refname rules forbid `..` anywhere — so splitting the `## ` line on the first
   `...` is unambiguous. The issue listed this as an edge case to handle; it is
   instead an edge case that cannot occur, and the plan says so rather than
   carrying a guard for it.
3. **`%s` is always exactly one line.** A commit whose message was
   `100% done\nsecond line…` rendered as a single folded subject, so
   `log -1 --format=%s%n%cr` reliably yields two lines: subject, then age.
4. **THE LOAD-BEARING ONE — `status` failing does not mean "not a repository".**
   With `.git/index` unreadable: `status` exits **128** while
   `rev-parse --is-inside-work-tree` exits **0** and prints `true`. So the issue's
   literal "three spawns" target, implemented naively, is a **bug**: `getInfo`
   would return `null` for a broken-but-real repo, and `lib/dir-scanner-child.js`
   derives whether a directory IS a project from `gitInfo && gitInfo.branch` — so
   the project would **vanish from the dashboard** rather than lose a badge. With
   a corrupt `.git/HEAD`, both commands fail, which is genuinely not-a-repository
   and matches today exactly.

## Requirements Confidence

**Level:** High — every parsing case above is measured rather than assumed, and the
one safety property that could regress has a fixture that reproduces it.

**[DECISION: `status` first, with `--is-inside-work-tree` kept as the authority on
"is this a repository" but deferred to the failure path | it preserves today's
not-a-repo determination EXACTLY — the same command decides it, so no regression on
that axis is possible whatever a broken repo does — while the healthy path, which
is nearly every path, pays three spawns | the alternative, inferring not-a-repo
from a failed `status`, is refuted by the `.git/index` probe above]**

**Honest accounting of the cost:** a directory that is NOT a repository goes from
one invocation to **two**, because `status` is tried before the probe that settles
it. Repositories — the overwhelming majority of registered projects — go from seven
to three, and a repository with no commits from four to one. The trade is stated
here rather than reported as a pure win.

## Status

- [x] Chunk 01: Three invocations, same answers, same failure semantics

Context: built 2026-08-12 on `fix/895-git-spawn-collapse` (worktree
`.claude/worktrees/git-spawns`). The invariant is **zero test failures at every
commit on this branch**; re-derive counts with `node --test 'test/*.test.js'`
rather than trusting a figure quoted here.

**Measured on this repository, warm, reading the same directory both ways:**

| | invocations | warm |
|---|---|---|
| before | **7** | 165.3 ms |
| after | **3** | 75.2 ms |

Every field identical across the two — branch, dirty, subject, age, tag,
`incomplete: []`. Counted at `child_process.execSync`, patched before `lib/git`
is required, so the *same* measurement runs against both revisions rather than
relying on a seam only one of them has.

**Every guard here was driven by its named mutation** — applied, watched go red,
restored, baseline re-confirmed green. The roster is in the tests themselves,
under `THE MUTATION THIS CATCHES`; grep for that phrase rather than trusting a
tally, which is what this paragraph used to carry and what went stale inside a
single review round.

Three of them exist because a review round found the defect they name: a failed
`status` discarding fields that were still answerable; an unborn HEAD tracking an
upstream (a clone of an EMPTY repository, which the shape table above never
probed); and a cause classifier that reported a repository we STOPPED as one git
refused to read — inverted in exactly the production direction, because every
real caller passes a positive budget and the guard was written against
`budgetMs: 0`, the one input production never supplies.

One #891 budget test was **rewritten, not deleted** — it stalled `rev-parse HEAD`,
a command nobody runs any more, so it had begun passing for a mechanism that no
longer exists. It now stalls `log`, which carries the same hazard. The reason is
in the test and in the commit message.

**Found while scrubbing, before review:** a `status` that succeeds but carries no
`## ` header would have parsed anyway — zero further lines counting as zero
changed paths — and reported a repository as definitely CLEAN on output nothing
understood. Unreachable from a healthy git, guarded regardless, since a false
"clean" is exactly the failure class this module exists to prevent.

Not yet done: Critic findings, then the PR.

`Critic mode:` cumulative-final — one chunk, one issue, one PR.

## Scaffolding

### Project Initialization

Existing repo. Node 22+, `node:test` built in; no `package.json` at the root.

### Dependencies

None added.

### Build & Test Configuration

`node --test 'test/*.test.js'` from the repo root.

### Scaffold Verification

**Work in a git worktree, not this clone** — the launchd server runs `server.js`
from this working tree (`WorkingDirectory` verified against the plist). Symlink the
gitignored `.prawduct/*` entries back to the primary **by explicit name**, plus
`.tangleclaw/plans`: a glob misses `.handoff-notes.md` and `.session-reflected`
whenever they do not already exist in the primary.

## Project Structure

```
lib/git.js        # _fetchInfo: the seven invocations become three
test/git.test.js  # real-repository fixtures for every row of the probe table
```

## Build Chunks

### Chunk 01: Three invocations, same answers, same failure semantics

- **Description:** Replace the seven-step read with `status --porcelain=v1 --branch`,
  `log -1 --format=%s%n%cr`, and the unchanged `describe --tags --abbrev=0`.
- **Deliverables:**
  - `_fetchInfo` issues three invocations on the healthy path. The `## ` line
    yields is-a-repo, branch, and — from whether any further lines follow — dirty.
    `log`'s two lines yield subject and age.
  - **Has-commits is read POSITIVELY** from `## No commits yet on`, replacing the
    `rev-parse HEAD` probe whose failure was treated as "no commits" — so a repo
    that fails that probe for any other reason stops being reported as empty.
  - On `status` failure only, `rev-parse --is-inside-work-tree` decides
    repository-or-not, exactly as today.
  - `step()`, the budget, `PER_CALL_CAP_MS` and the partial-not-cached rule keep
    their semantics. `step` gained `weStopped` and `_reportIncomplete` a `cause`,
    both so the log can tell a slow repository from a broken one. One invocation now establishes several
    fields, so a `status` the budget could not run names `branch` AND `dirty` in
    `incomplete` — and `dirty` stays `null`, never `false`.
- **Acceptance criteria** (each with the mutation that must drive it red):
  - Healthy repo with commits → exactly **3** invocations. *Mutation:* restore any
    removed invocation; the count goes to 4.
  - Repo with no commits → **1** invocation, `branch` is the real branch name,
    `lastCommit`/`lastCommitAge`/`latestTag` empty, and it is NOT marked incomplete.
    *Mutation:* infer has-commits from a failed `log` instead of the `## ` line.
  - **A repo whose `.git/index` is unreadable still returns an object with a
    branch-bearing shape and names its unestablished fields — it does NOT return
    `null`.** *Mutation:* treat a failed `status` as not-a-repository; the fixture
    project disappears. This is the criterion the whole design turns on.
  - A directory that is genuinely not a repository still returns `null`.
  - Detached HEAD → `branch === 'HEAD'`, matching today's `rev-parse --abbrev-ref`.
  - Upstream and ahead/behind forms parse to the branch name alone.
  - Dirty and clean both resolve correctly; `dirty` is `null` (never `false`) when
    `status` could not run.
  - Budget exhausted before `status` → every field named in `incomplete`, object
    still returned with `branch: 'unknown'`, nothing cached.
- **Deliberately not done:** the `## ` line also carries ahead/behind counts, which
  nothing currently renders. Parsing them into new fields would be scope the issue
  did not ask for; the line is read for branch and nothing else.

## Verification Strategy

Fixtures are **real repositories** built per probe row, not stubbed `git` output —
the subject is what `git` actually prints, and a stub asserts the author's model of
that (the standing lesson in `lib/exec-timeout.js`, where three hand-written
predicates shipped dead).

Invocation counts are asserted by counting, not timed: the seven calls cost tens of ms
warm on this repository, so wall-clock cannot distinguish three from seven
reliably. Re-measure warm cost before and after and put both numbers in the PR, as
the issue asks — as supporting evidence, not as the criterion.

## Artifacts To Update

- `lib/git.js` — `GIT_INFO_BUDGET_MS`'s comment states "seven `git` invocations"
  and quotes a warm figure for them; both are wrong the moment this
  lands.
- `architecture.md` Scaling Model — mentions the child's git work per poll.
- `CHANGELOG.md` `[Unreleased]` → `### Internal` (no user-visible behavior change
  beyond a fresh repo gaining its real branch name, which goes in `### Fixed`).
