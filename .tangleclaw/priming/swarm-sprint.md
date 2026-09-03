# Priming prompt — swarm sprint (parallel multi-car train)

Paste this into the coordinator session before fanning out. Not a startup rule: it only
applies when you are actually running a swarm, so it does not belong in `CLAUDE.md`'s
always-loaded budget.

## How to use

1. Decide the roster from **GitHub milestones**, not from ranking issues.
2. Paste the block below, then append the roster (one line per car: issue, chunk, branch).
3. Keep the coordinator out of the cars' repos — it merges, it does not build.

---

## Paste block

You are the coordinator for a parallel sprint. Cars build in per-agent git worktrees; the
primary checkout stays on `main` (it is the live install — the server serves `public/` off
the working tree).

**Batch size: 5–6 cars, not 15+.** Enough to saturate the writing phase; small enough that
the merge queue stays roughly linear. See below for why.

**A car is done when its full suite is green.** Not when the code is written. A branch pushed
with tests unrun has moved work, not finished it, and whoever picks it up pays full price to
find out. `node --test 'test/*.test.js'` before you report complete, and say the pass count.

**Name the shared files before you fan out.** Every car that appends to `CHANGELOG.md`,
`FEATURES.md`, or the plan's `## Status` list re-serializes at merge — N cars means N conflict
resolutions, and each merge invalidates the rebases of everyone still queued. That is the real
schedule. Until #1220 lands (per-branch `changelog.d/` fragments), either sequence the cars
that share a file, or have ONE agent write every changelog entry at the end from the merged
diffs.

**Never `git stash` in a worktree.** All worktrees share one stash list; two parallel builders
popped each other's edits on Train 12. Use a temporary WIP commit, or `git diff` to a file.

**Do not spawn an agent for work you can name as a command.** A general-purpose agent costs
~140k tokens just reading itself into this repo. That amortizes over an hour of building and
is pure waste on `gh pr merge --auto` — which cost 141k tokens and 19 minutes on Train 12,
with another agent queued behind it. Rule of thumb: if you can write the exact command, run
it yourself.

**Budget the Critic in from the start.** Every car needs a review, and the train needs a
cumulative. A review runs ~10 minutes on a three-reviewer roster and finds real blocking
defects — Train 12's #1213 review found one blocking plus fourteen warnings, several of them
genuine bugs. If reviews are not in the token plan, the swarm is writing debt at speed.

**Watch for cross-car collisions — no single car can see them.** Two cars editing the same
function are each individually correct and break on rebase (Train 12: #83 and #185 both
touched `confirmWrap`; the parity test's vm sandbox lifted the function without the new
collaborator). When two cars name the same file, review the pair, not each alone.

**Write the handoff as you go.** `.prawduct/.handoff-notes.md`, updated at each car close —
read it and reconcile before rewriting, never blind-append. A swarm dies with its session;
only the branches, the PRs, and this file survive a `/clear`.

---

## Update history

- **2026-09-03** — Created from the Train 12 retrospective (~18 agents, 15 cars). Every rule
  here is a cost that train actually paid, not a precaution. Related: learning
  "a swarm parallelizes writing code and then re-serializes at merge", issue #1220.
