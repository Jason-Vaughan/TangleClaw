---
title: "#1629 — the wrap commit feeds a removed rename source back to `git add`"
status: in progress
authorized_by: TangleClaw-ProjectManager, 2026-09-18 (implementation freeze lifted strictly for #1629)
issue: https://github.com/Jason-Vaughan/TangleClaw/issues/1629
branch: fix/wrap-rename-pathspec-1629
scope: wrap-rename-pathspec-1629
Critic mode: chunk
governed_by:
  - .prawduct/artifacts/wrap-direction.md   # its ## Direction binds all wrap work, and this adds a hard gate
---

# #1629 — a staged rename blocks the wrap commit

## Confidence check

- **Problem.** `lib/wrap-steps/commit.js` passes ONE list (`classified.stageable`) to both
  `git add -A` and `git commit`. For a staged rename, `parseStatus` reports both halves, and the
  source has already been removed from the index — so `git add` exits 128 with
  `pathspec '…' did not match any files` and the wrap blocks at `commit` with `commitSha: null`.
  Builder2 hit this on deployed main; the issue carries an independent reproduction.
- **Success.** A wrap whose tree contains a staged rename commits it as a rename, stages nothing it
  was not authorized to, leaves the operator's own staged work staged and uncommitted, and a rename
  whose halves straddle the include/leave boundary is refused in words rather than half-published.
- **Out of scope.** The separate triage observation in the issue (content steps completing via file
  detection while the agent reported follow-on work). Unrelated cleanup. Any release.
- **Explicitly descoped, filed not dropped:** `session-files` builds the same classification and
  collects the Include/Leave decisions, but does not read `splitRenames` — so an operator making a
  split decision is told at `commit`, one step after the drawer closed. The commit step refuses
  safely and leaves no residue, so this is a timing-of-feedback gap and not a correctness one.
  Filed as #1630 rather than folded in late (Critic R-11).

**Requirements confidence: High.** The issue specifies the contract, and I reproduced the failure
and the fix shape against real git before writing this.

## What real git actually does (measured, not assumed)

| index state | `git add -A <path>` | why |
|---|---|---|
| `R` rename source | **exit 128** | already removed from the index |
| `D ` staged deletion | **exit 128** | already removed from the index |
| ` D` unstaged deletion | exit 0 | still in the index; add stages the removal |
| present / modified | exit 0 | — |

And `git commit --pathspec-from-file` **accepts** the removed source: given `new.md` staged and both
names in the commit pathspec, the commit records a proper `old.md => new.md` rename. So the split is
add-vs-commit, exactly as the issue's proposed contract says.

**The discriminator is "already removed from the index", not "absent from disk".** An unstaged
deletion is also absent from disk and MUST stay addable, or the wrap stops committing ordinary
file removals.

## Steps

- [x] **1. `parseStatus` carries index state and rename pairing.** Today it returns
  `{path, deleted}` and discards XY, so no caller can tell an already-staged removal from an
  unstaged one. Add `indexRemoved` (X is `R` or `D`) and a `renamePair` id linking the two halves.
  Both fields are additive — `path` and `deleted` keep their meaning, because
  `_tc-owned-paths.judge` and existing tests read them.
  Tests: `test/wrap-file-ownership.test.js`, driven from real `git status --porcelain -z` output.

- [x] **2. `classify` returns `addable` beside `stageable`.** `stageable` keeps its meaning — the
  complete authorized commit selection — and `addable` is that minus the `indexRemoved` paths.
  `stageableOf` gains an `addableOf` sibling so the "rebuilds a classification" callers
  (`_secret-check`) cannot drift, which is the #1513 rule that bucket already carries.

- [x] **3. A rename that straddles include/leave is refused, not half-published.** If one half is
  authorized and the other is left, committing it turns a rename into an add (leaving the source
  tracked) or into a delete. `classify` reports the pair as a conflict; the commit step blocks with
  a message naming both paths and the decision needed. Consistent decisions apply to both halves.

- [x] **4. `commit.js` uses the right list for each command.** `git add -A` gets `addable`;
  `git commit` keeps the full `stageable` pathspec. In `_commitWithUntrack` the commit takes no
  pathspec — it commits the whole temp index — so the `indexRemoved` paths must also be removed
  from that temp index, or the rename source would survive in the commit. Measured, not assumed.

- [x] **5. Acceptance against real git**, per the issue: staged and unstaged renames, already-staged
  deletions, unrelated staged work preserved, include/leave combinations, and literal
  special-character filenames. Assert the resulting COMMIT CONTENTS and the surviving index — not
  mocked command arguments.

- [ ] **6. Record and wrap.** CHANGELOG, Status ticks, `/prawduct:critic`, handoff.

## Done when

Every box ticked, suite green, Critic clean, and the issue's reproduction — `git mv` then wrap —
produces a commit containing the rename. PR is NOT opened: the push/rebase/merge freeze is still in
force, so this lands as local commits until the operator or the PM lifts it.
