# Preservation receipt — TangleClaw-Builder2 checkout

Written 2026-10-06 ~01:15Z by the Builder2 session, for PM fleet-drain dispatch 3c687e3e (v5.31.0 update sequence). Checkout: `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2`. Fetched and pruned `origin` first; `origin/main` was `eda5e1b9`. `tc branch check` was run on all 22 local branches. **Nothing was deleted, reset, pushed, stashed or cleaned.**

## A. Holds work that exists NOWHERE else — must be preserved

| What | Tip | Why it matters |
|---|---|---|
| `fix/1628-status-row-provenance` and `backup/1628-pre-recovery-0bdab50` | both `0bdab503` | **`tc branch check` reads `safe` for each, and that is wrong for the pair.** They point at the same commit, so each vouches for the other. Their 7 commits (2026-09-18, 15 files, +969/−22) are on no remote ref and none is patch-equivalent to anything on `main`. One is titled "WIP checkpoint: #1628 handoff to Builder1 — NOT APPROVED FOR MERGE". Issue #1628 is closed, by a different approach (PR #1840, app-server readiness). Deleting either branch is harmless only while the other exists; deleting both loses the work. |
| `wrap/20260918215717-tangleclaw-builder2` | `afa5573e` | 1 commit, no PR, not on `main` (7 files, +5/−3: session-wrap bookkeeping in `CHANGELOG.md`, `PROJECT-MAP.md` and others). Small, but unique. |
| `keep/2032-pre-rebase-20260929` | `935e219b` | Pre-rebase snapshot of PR #2038 (merged, #2032 closed). 6 of its 7 commits are patch-equivalent on `main`; `be9bb6b8` is not, and the snapshot differs from the merged result (18 files). Probably superseded by the rebase, not verified line by line. It is a deliberate `keep/` pin. |
| Main checkout uncommitted edits | on `main` @ `41b09ea6` | `CLAUDE.md` (+3/−1) and `FEATURES.md` (+5/−8), unstaged, predating 2026-09-30. On no ref at all. `main` itself is 404 behind `origin/main`. |
| Stash `stash@{0}` | `5ce8bcf3` | "WIP on main: 41b09ea6", dated 2026-09-29, touching `CLAUDE.md` and `FEATURES.md`. The stash stack is shared by every worktree of this clone; I did not create it this session and do not know its owner. |
| Gitignored governance evidence | 10 worktrees + main | Each worktree's `.prawduct/` holds its review ledger, Critic findings, PR-review and test evidence (3 to 9 ignored files each; 90 in the main checkout). `git worktree remove` deletes these without refusing. |

## B. `preserve` by the tool, but fully accounted for — nothing would be lost

Twelve branches whose PRs are MERGED. In every case the local tip **equals the PR's recorded head** (GitHub keeps `refs/pull/<n>/head`), and the tip's content on the branch's own files is identical to the merged commit. The "unique commits" are the pre-squash originals.

| Branch | Tip | PR |
|---|---|---|
| `docs/575-http-port-redirect-hosts` | `3dd2b78d` | #2082 |
| `fix/1902-inline-handler-jsarg-main` | `0f2ba9e7` | #2087 |
| `fix/2020-dhcp-timing-derivation` | `1b060218` | #2060 |
| `fix/2020-dryrun-a1-tooling` | `b4d4e42f` | #2066 |
| `fix/2020-dryrun-a1-runbooks` | `0b06f046` | #2067 |
| `fix/2020-dryrun-a1-medusa-stub` | `6b427ceb` | #2068 |
| `fix/2020-lease-start-mdy` | `d8bc8b8d` | #2062 |
| `fix/2061-fingerprint-deadline-sentinel` | `620d914e` | #2065 |
| `fix/2068-hub-plist-tmp` | `556c8185` | #2069 |
| `wrap/20260924060539-tangleclaw-builder2` | `3ad30cf1` | #1841 |
| `wrap/20260926143319-tangleclaw-builder2` | `4d39273a` | #1898 |
| `wrap/20260926184529-tangleclaw-builder2` | `40821170` | #1910 |

Each is checked out in a clean worktree except the three `wrap/` branches, which no worktree holds.

## C. No unique commits

| Branch | State |
|---|---|
| `fix/1946-panel-toggle-focus-main` (`9305d9ef`), `fix/1964-receipt-test-sequencing` (`40f7b7eb`) | True-merged (#2090, #2084); every commit is on `main`. `preserve` only because a clean worktree holds each. |
| `feat/operator-channel` (`25f03e01`) | 57 behind `origin/feat/operator-channel` (`3efdca1e`) and an ancestor of it: the local copy is simply stale, with nothing of its own. PR #1966 is CLOSED (superseded). Clean worktree, 9 ignored files. |
| `docs/features-stub-fill` (`adae8da4`) | Level with its remote. Clean worktree. |
| `wrap/20260926225657-tangleclaw-builder2` | `safe`, all reachable. |
| `main` (`41b09ea6`) | No unique commits; `preserve` because it is checked out and dirty (see A). |
| Detached worktree `ci-aea0c4f8` | `aea0c4f8` is on 5 remote refs. Clean, no ignored files. |

## Verdict

Not every branch is "genuinely accounted for with nothing lost": section A is real, unique, undispositioned work. So this session **did not finalize** and holds at rest. `tc finalize` would refuse anyway (`OWNED_WORK_PRESENT`).

What would make this checkout safe for a production update that only fetches or restarts the server: nothing more; none of this is touched by that. What would lose work: `git reset --hard` or `git clean` in the main checkout, `git stash drop/clear`, `git worktree remove` or `prune --force`, `git branch -D` on anything in A, or `git gc --prune=now` after any of those.

Cheapest durable fix if wanted (needs a dispatch; I have not done it): push the section-A branches to `origin` under a `preserve/builder2/` prefix, and commit the main-checkout edits to a branch of their own.

---

# Appendix — raw machine outputs

Appended 2026-10-06T01:09:48Z at the PM's request (Medusa b8ef87c9, Architect ruling A62). Everything below is literal command output from `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2`, captured in one pass. The narrative above was written from an earlier run of the same commands (about 01:06Z); this pass re-ran them. sha256 of this file before the appendix was added: `2f878fcd95708ca756783425b077fe309a702ada6c668fe97eaf6bad39f6d45d`.

## 1. `tc branch check <branch>` for all 22 local branches

Each block is the command, its literal output, then its exit code (0 safe, 3 preserve, 4 unknown).

### `backup/1628-pre-recovery-0bdab50`

```
$ tc branch check backup/1628-pre-recovery-0bdab50
branch backup/1628-pre-recovery-0bdab50: SAFE to retire
  ref:       refs/heads/backup/1628-pre-recovery-0bdab50 @ 0bdab503dc143b4cba4d30e74db7d42249cfa2be
  upstream:  (none configured)
  fetch:     origin refreshed at 2026-10-06T01:09:48.563Z
  unique:    0 commit(s) on no other ref
  worktrees: 15 listed; none holds this branch
  reasons:
    [ALL_REACHABLE] every commit is reachable from another local branch, a tag, or the freshly fetched remote
  next:      Every commit on 'backup/1628-pre-recovery-0bdab50' is reachable from another ref. It may be deleted with `git branch -d backup/1628-pre-recovery-0bdab50` — run `tc branch check` again immediately before if anything has changed since this check.
[exit 0]
```

### `docs/575-http-port-redirect-hosts`

```
$ tc branch check docs/575-http-port-redirect-hosts
branch docs/575-http-port-redirect-hosts: PRESERVE — do not retire
  ref:       refs/heads/docs/575-http-port-redirect-hosts @ 3dd2b78d516c7bd672928722f7ea5153b7673eba
  upstream:  origin/docs/575-http-port-redirect-hosts
  fetch:     origin refreshed at 2026-10-06T01:09:49.104Z
  unique:    3 commit(s) on no other ref
             3dd2b78d516c7bd672928722f7ea5153b7673eba
             d9944a13e31ec97a7667f7c5e9d0f51b09abd6b3
             90d72ebbb1281a6b10b6226a487831580a38edd7
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/575-docs (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 3 commit(s) exist only on 'docs/575-http-port-redirect-hosts'
    [CHECKED_OUT] 'docs/575-http-port-redirect-hosts' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/575-docs
  next:      Do not delete or reset 'docs/575-http-port-redirect-hosts'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/575-docs), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `docs/features-stub-fill`

```
$ tc branch check docs/features-stub-fill
branch docs/features-stub-fill: PRESERVE — do not retire
  ref:       refs/heads/docs/features-stub-fill @ adae8da419ef4a0f313492efe948394dc94e515d
  upstream:  origin/docs/features-stub-fill
  fetch:     origin refreshed at 2026-10-06T01:09:49.859Z
  unique:    0 commit(s) on no other ref
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/features-stub-fill (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [CHECKED_OUT] 'docs/features-stub-fill' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/features-stub-fill
  next:      Do not delete or reset 'docs/features-stub-fill'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/features-stub-fill), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `feat/operator-channel`

```
$ tc branch check feat/operator-channel
branch feat/operator-channel: PRESERVE — do not retire
  ref:       refs/heads/feat/operator-channel @ 25f03e0185887b6776adee5291a172301c4fe980
  upstream:  origin/feat/operator-channel
  fetch:     origin refreshed at 2026-10-06T01:09:50.469Z
  unique:    0 commit(s) on no other ref
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/operator-channel (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [CHECKED_OUT] 'feat/operator-channel' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/operator-channel
  next:      Do not delete or reset 'feat/operator-channel'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/operator-channel), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/1628-status-row-provenance`

```
$ tc branch check fix/1628-status-row-provenance
branch fix/1628-status-row-provenance: SAFE to retire
  ref:       refs/heads/fix/1628-status-row-provenance @ 0bdab503dc143b4cba4d30e74db7d42249cfa2be
  upstream:  origin/main
  fetch:     origin refreshed at 2026-10-06T01:09:51.108Z
  unique:    0 commit(s) on no other ref
  worktrees: 15 listed; none holds this branch
  reasons:
    [ALL_REACHABLE] every commit is reachable from another local branch, a tag, or the freshly fetched remote
  next:      Every commit on 'fix/1628-status-row-provenance' is reachable from another ref. It may be deleted with `git branch -d fix/1628-status-row-provenance` — run `tc branch check` again immediately before if anything has changed since this check.
[exit 0]
```

### `fix/1902-inline-handler-jsarg-main`

```
$ tc branch check fix/1902-inline-handler-jsarg-main
branch fix/1902-inline-handler-jsarg-main: PRESERVE — do not retire
  ref:       refs/heads/fix/1902-inline-handler-jsarg-main @ 0f2ba9e76141449fad1d01520c1fa959b8914282
  upstream:  origin/fix/1902-inline-handler-jsarg-main
  fetch:     origin refreshed at 2026-10-06T01:09:51.640Z
  unique:    2 commit(s) on no other ref
             0f2ba9e76141449fad1d01520c1fa959b8914282
             91378ff0bffa4e15550bd0368d70e238bb34a02f
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1902-jsarg (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 2 commit(s) exist only on 'fix/1902-inline-handler-jsarg-main'
    [CHECKED_OUT] 'fix/1902-inline-handler-jsarg-main' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1902-jsarg
  next:      Do not delete or reset 'fix/1902-inline-handler-jsarg-main'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1902-jsarg), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/1946-panel-toggle-focus-main`

```
$ tc branch check fix/1946-panel-toggle-focus-main
branch fix/1946-panel-toggle-focus-main: PRESERVE — do not retire
  ref:       refs/heads/fix/1946-panel-toggle-focus-main @ 9305d9efa36e430368d6c26bb58823e2d5dd570a
  upstream:  origin/fix/1946-panel-toggle-focus-main
  fetch:     origin refreshed at 2026-10-06T01:09:52.213Z
  unique:    0 commit(s) on no other ref
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1946-focus (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [CHECKED_OUT] 'fix/1946-panel-toggle-focus-main' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1946-focus
  next:      Do not delete or reset 'fix/1946-panel-toggle-focus-main'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1946-focus), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/1964-receipt-test-sequencing`

```
$ tc branch check fix/1964-receipt-test-sequencing
branch fix/1964-receipt-test-sequencing: PRESERVE — do not retire
  ref:       refs/heads/fix/1964-receipt-test-sequencing @ 40f7b7eb5848e12e9e4d9aa934f51a85dbf74b52
  upstream:  origin/fix/1964-receipt-test-sequencing
  fetch:     origin refreshed at 2026-10-06T01:09:52.795Z
  unique:    0 commit(s) on no other ref
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1964-receipt (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [CHECKED_OUT] 'fix/1964-receipt-test-sequencing' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1964-receipt
  next:      Do not delete or reset 'fix/1964-receipt-test-sequencing'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1964-receipt), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/2020-dhcp-timing-derivation`

```
$ tc branch check fix/2020-dhcp-timing-derivation
branch fix/2020-dhcp-timing-derivation: PRESERVE — do not retire
  ref:       refs/heads/fix/2020-dhcp-timing-derivation @ 1b060218c0b41dace9c2cb4e0f2eb1f22ead90cc
  upstream:  origin/fix/2020-dhcp-timing-derivation
  fetch:     origin refreshed at 2026-10-06T01:09:53.463Z
  unique:    5 commit(s) on no other ref
             1b060218c0b41dace9c2cb4e0f2eb1f22ead90cc
             08c784beb4152e05b14b56ac0cabf9f1d0deaa6a
             fbcc28199505b705233d6d595659fd118a5f0e71
             50adc46cf7a56f4cf8e0552ae4e32d2a4f1f2d4f
             bffe91d58cb4e8edb776d85061d99fa8d6ed7ff1
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dhcp (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 5 commit(s) exist only on 'fix/2020-dhcp-timing-derivation'
    [CHECKED_OUT] 'fix/2020-dhcp-timing-derivation' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dhcp
  next:      Do not delete or reset 'fix/2020-dhcp-timing-derivation'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dhcp), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/2020-dryrun-a1-medusa-stub`

```
$ tc branch check fix/2020-dryrun-a1-medusa-stub
branch fix/2020-dryrun-a1-medusa-stub: PRESERVE — do not retire
  ref:       refs/heads/fix/2020-dryrun-a1-medusa-stub @ 6b427ceb513cffb0690dbe0c329a0fb08a7df021
  upstream:  origin/fix/2020-dryrun-a1-medusa-stub
  fetch:     origin refreshed at 2026-10-06T01:09:54.040Z
  unique:    3 commit(s) on no other ref
             6b427ceb513cffb0690dbe0c329a0fb08a7df021
             03f802ccaeba0e05b8d7ad44edda75365eeddc5f
             9d58c044c45c6edcb17bced941b7a29253363c31
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c3 (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 3 commit(s) exist only on 'fix/2020-dryrun-a1-medusa-stub'
    [CHECKED_OUT] 'fix/2020-dryrun-a1-medusa-stub' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c3
  next:      Do not delete or reset 'fix/2020-dryrun-a1-medusa-stub'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c3), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/2020-dryrun-a1-runbooks`

```
$ tc branch check fix/2020-dryrun-a1-runbooks
branch fix/2020-dryrun-a1-runbooks: PRESERVE — do not retire
  ref:       refs/heads/fix/2020-dryrun-a1-runbooks @ 0b06f0468e2b75ef66dec82ca0060ed2561aac93
  upstream:  origin/fix/2020-dryrun-a1-runbooks
  fetch:     origin refreshed at 2026-10-06T01:09:54.624Z
  unique:    2 commit(s) on no other ref
             0b06f0468e2b75ef66dec82ca0060ed2561aac93
             3c9525ec619df392a09cf8b4b2b9248a439e8a9f
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c2 (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 2 commit(s) exist only on 'fix/2020-dryrun-a1-runbooks'
    [CHECKED_OUT] 'fix/2020-dryrun-a1-runbooks' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c2
  next:      Do not delete or reset 'fix/2020-dryrun-a1-runbooks'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c2), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/2020-dryrun-a1-tooling`

```
$ tc branch check fix/2020-dryrun-a1-tooling
branch fix/2020-dryrun-a1-tooling: PRESERVE — do not retire
  ref:       refs/heads/fix/2020-dryrun-a1-tooling @ b4d4e42f0302352cdaca98cd2b2891c196a9d55a
  upstream:  origin/fix/2020-dryrun-a1-tooling
  fetch:     origin refreshed at 2026-10-06T01:09:55.196Z
  unique:    3 commit(s) on no other ref
             b4d4e42f0302352cdaca98cd2b2891c196a9d55a
             178435b8c6c761043137b540f716c2bdfa37a801
             5c419b47c2cb30e666ac61abc09836c97e571144
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1 (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 3 commit(s) exist only on 'fix/2020-dryrun-a1-tooling'
    [CHECKED_OUT] 'fix/2020-dryrun-a1-tooling' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1
  next:      Do not delete or reset 'fix/2020-dryrun-a1-tooling'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/2020-lease-start-mdy`

```
$ tc branch check fix/2020-lease-start-mdy
branch fix/2020-lease-start-mdy: PRESERVE — do not retire
  ref:       refs/heads/fix/2020-lease-start-mdy @ d8bc8b8d2874025c1a61f3112eaa77b2cd89b719
  upstream:  origin/fix/2020-lease-start-mdy
  fetch:     origin refreshed at 2026-10-06T01:09:55.773Z
  unique:    7 commit(s) on no other ref
             d8bc8b8d2874025c1a61f3112eaa77b2cd89b719
             da4783132cde6d883c077aa31925dd4e1dcfa8c5
             fc705c1357932865569410d2d03dbc402e97d620
             3ea36314fbfe6718379a25614d69db9180d16c62
             6e1cdcb2a3595b63b321f329e53affd1cde2c304
             86588db439bd61661c0fa31d3092ccb64b31b690
             ba2ba370c609f10976271a530e8fb47dc6ab5c65
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-lease-start (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 7 commit(s) exist only on 'fix/2020-lease-start-mdy'
    [CHECKED_OUT] 'fix/2020-lease-start-mdy' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-lease-start
  next:      Do not delete or reset 'fix/2020-lease-start-mdy'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-lease-start), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/2061-fingerprint-deadline-sentinel`

```
$ tc branch check fix/2061-fingerprint-deadline-sentinel
branch fix/2061-fingerprint-deadline-sentinel: PRESERVE — do not retire
  ref:       refs/heads/fix/2061-fingerprint-deadline-sentinel @ 620d914e3a5eacad2399c8057c2be1f944e905c3
  upstream:  origin/fix/2061-fingerprint-deadline-sentinel
  fetch:     origin refreshed at 2026-10-06T01:09:56.335Z
  unique:    1 commit(s) on no other ref
             620d914e3a5eacad2399c8057c2be1f944e905c3
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2061 (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 1 commit(s) exist only on 'fix/2061-fingerprint-deadline-sentinel'
    [CHECKED_OUT] 'fix/2061-fingerprint-deadline-sentinel' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2061
  next:      Do not delete or reset 'fix/2061-fingerprint-deadline-sentinel'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2061), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `fix/2068-hub-plist-tmp`

```
$ tc branch check fix/2068-hub-plist-tmp
branch fix/2068-hub-plist-tmp: PRESERVE — do not retire
  ref:       refs/heads/fix/2068-hub-plist-tmp @ 556c818554d62aa540e954a315a7c57c52b28b31
  upstream:  origin/fix/2068-hub-plist-tmp
  fetch:     origin refreshed at 2026-10-06T01:09:56.896Z
  unique:    2 commit(s) on no other ref
             556c818554d62aa540e954a315a7c57c52b28b31
             cd77c8630e3e78992b893534c959d537f84f561b
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2068-hub-tmp (checked out; 0 staged, 0 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [UNIQUE_COMMITS] 2 commit(s) exist only on 'fix/2068-hub-plist-tmp'
    [CHECKED_OUT] 'fix/2068-hub-plist-tmp' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2068-hub-tmp
  next:      Do not delete or reset 'fix/2068-hub-plist-tmp'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2068-hub-tmp), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `keep/2032-pre-rebase-20260929`

```
$ tc branch check keep/2032-pre-rebase-20260929
branch keep/2032-pre-rebase-20260929: PRESERVE — do not retire
  ref:       refs/heads/keep/2032-pre-rebase-20260929 @ 935e219b11f3804ea1118afe5f2839a9b1ba402d
  upstream:  (none configured)
  fetch:     origin refreshed at 2026-10-06T01:09:57.490Z
  unique:    7 commit(s) on no other ref
             935e219b11f3804ea1118afe5f2839a9b1ba402d
             69a61875acfcbe8df2bfd07d7ac5ee3c8c71fb6c
             b2ce36a92dd70014e1674cc785c2b44c2dbd896e
             17b84ed75c586188b2a3d9f8ceebc97d29997561
             e2d99ebf9adc390b900fe5bcd0dde58ecf000d16
             be9bb6b80e5cd318b49598b57cca8d605d609f42
             6dbad2ba0eb28398eeab54936d6fce71c92d05b9
  worktrees: 15 listed; none holds this branch
  reasons:
    [UNIQUE_COMMITS] 7 commit(s) exist only on 'keep/2032-pre-rebase-20260929'
  next:      Do not delete or reset 'keep/2032-pre-rebase-20260929'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). Do not rely on the reflog to recover anything.
[exit 3]
```

### `main`

```
$ tc branch check main
branch main: PRESERVE — do not retire
  ref:       refs/heads/main @ 41b09ea682996d5cf4624ba388cd4d295a1012cb
  upstream:  origin/main
  fetch:     origin refreshed at 2026-10-06T01:09:58.073Z
  unique:    0 commit(s) on no other ref
  worktrees: 15 listed; 1 hold this branch:
             /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2 (checked out; 0 staged, 2 unstaged, 0 unmerged, 0 untracked)
  reasons:
    [CHECKED_OUT] 'main' is checked out in the worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2
    [WORKTREE_DIRTY] worktree at /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2 has 0 staged, 2 unstaged, 0 unmerged and 0 untracked path(s)
  next:      Do not delete or reset 'main'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). To retire the worktree holding it (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2), first confirm `git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain `git worktree remove <tree>` (never `--force`), then run `tc branch check` again. Do not rely on the reflog to recover anything.
[exit 3]
```

### `wrap/20260918215717-tangleclaw-builder2`

```
$ tc branch check wrap/20260918215717-tangleclaw-builder2
branch wrap/20260918215717-tangleclaw-builder2: PRESERVE — do not retire
  ref:       refs/heads/wrap/20260918215717-tangleclaw-builder2 @ afa5573ed03ed096841a80ab156efb7c84237dbf
  upstream:  (none configured)
  fetch:     origin refreshed at 2026-10-06T01:09:58.668Z
  unique:    1 commit(s) on no other ref
             afa5573ed03ed096841a80ab156efb7c84237dbf
  worktrees: 15 listed; none holds this branch
  reasons:
    [UNIQUE_COMMITS] 1 commit(s) exist only on 'wrap/20260918215717-tangleclaw-builder2'
  next:      Do not delete or reset 'wrap/20260918215717-tangleclaw-builder2'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). Do not rely on the reflog to recover anything.
[exit 3]
```

### `wrap/20260924060539-tangleclaw-builder2`

```
$ tc branch check wrap/20260924060539-tangleclaw-builder2
branch wrap/20260924060539-tangleclaw-builder2: PRESERVE — do not retire
  ref:       refs/heads/wrap/20260924060539-tangleclaw-builder2 @ 3ad30cf11bdf129a4c885c13965d379ec8a8cc95
  upstream:  origin/wrap/20260924060539-tangleclaw-builder2
  fetch:     origin refreshed at 2026-10-06T01:09:59.210Z
  unique:    1 commit(s) on no other ref
             3ad30cf11bdf129a4c885c13965d379ec8a8cc95
  worktrees: 15 listed; none holds this branch
  reasons:
    [UNIQUE_COMMITS] 1 commit(s) exist only on 'wrap/20260924060539-tangleclaw-builder2'
  next:      Do not delete or reset 'wrap/20260924060539-tangleclaw-builder2'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). Do not rely on the reflog to recover anything.
[exit 3]
```

### `wrap/20260926143319-tangleclaw-builder2`

```
$ tc branch check wrap/20260926143319-tangleclaw-builder2
branch wrap/20260926143319-tangleclaw-builder2: PRESERVE — do not retire
  ref:       refs/heads/wrap/20260926143319-tangleclaw-builder2 @ 4d39273af8cd60ce9ea584cf5140b82f0da6dc6f
  upstream:  origin/wrap/20260926143319-tangleclaw-builder2
  fetch:     origin refreshed at 2026-10-06T01:09:59.757Z
  unique:    1 commit(s) on no other ref
             4d39273af8cd60ce9ea584cf5140b82f0da6dc6f
  worktrees: 15 listed; none holds this branch
  reasons:
    [UNIQUE_COMMITS] 1 commit(s) exist only on 'wrap/20260926143319-tangleclaw-builder2'
  next:      Do not delete or reset 'wrap/20260926143319-tangleclaw-builder2'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). Do not rely on the reflog to recover anything.
[exit 3]
```

### `wrap/20260926184529-tangleclaw-builder2`

```
$ tc branch check wrap/20260926184529-tangleclaw-builder2
branch wrap/20260926184529-tangleclaw-builder2: PRESERVE — do not retire
  ref:       refs/heads/wrap/20260926184529-tangleclaw-builder2 @ 4082117028af0118340eca8a1a8adf64b69e7a18
  upstream:  origin/wrap/20260926184529-tangleclaw-builder2
  fetch:     origin refreshed at 2026-10-06T01:10:00.302Z
  unique:    1 commit(s) on no other ref
             4082117028af0118340eca8a1a8adf64b69e7a18
  worktrees: 15 listed; none holds this branch
  reasons:
    [UNIQUE_COMMITS] 1 commit(s) exist only on 'wrap/20260926184529-tangleclaw-builder2'
  next:      Do not delete or reset 'wrap/20260926184529-tangleclaw-builder2'. To continue on fresh code, create a separate clean worktree: `git fetch --prune origin` then `git worktree add <new-path> origin/main` (verify the fetch succeeded before using origin/main). Do not rely on the reflog to recover anything.
[exit 3]
```

### `wrap/20260926225657-tangleclaw-builder2`

```
$ tc branch check wrap/20260926225657-tangleclaw-builder2
branch wrap/20260926225657-tangleclaw-builder2: SAFE to retire
  ref:       refs/heads/wrap/20260926225657-tangleclaw-builder2 @ 14e90c25d87b72739cd589488287ffab69a4dacf
  upstream:  origin/wrap/20260926225657-tangleclaw-builder2
  fetch:     origin refreshed at 2026-10-06T01:10:00.835Z
  unique:    0 commit(s) on no other ref
  worktrees: 15 listed; none holds this branch
  reasons:
    [ALL_REACHABLE] every commit is reachable from another local branch, a tag, or the freshly fetched remote
  next:      Every commit on 'wrap/20260926225657-tangleclaw-builder2' is reachable from another ref. It may be deleted with `git branch -d wrap/20260926225657-tangleclaw-builder2` — run `tc branch check` again immediately before if anything has changed since this check.
[exit 0]
```

## 2. Refs manifest

```
$ git for-each-ref --format='%(objectname) %(objecttype) %(refname) %(upstream:short) %(upstream:track)'
0bdab503dc143b4cba4d30e74db7d42249cfa2be commit refs/heads/backup/1628-pre-recovery-0bdab50  
3dd2b78d516c7bd672928722f7ea5153b7673eba commit refs/heads/docs/575-http-port-redirect-hosts origin/docs/575-http-port-redirect-hosts [gone]
adae8da419ef4a0f313492efe948394dc94e515d commit refs/heads/docs/features-stub-fill origin/docs/features-stub-fill 
25f03e0185887b6776adee5291a172301c4fe980 commit refs/heads/feat/operator-channel origin/feat/operator-channel [behind 57]
0bdab503dc143b4cba4d30e74db7d42249cfa2be commit refs/heads/fix/1628-status-row-provenance origin/main [ahead 7, behind 628]
0f2ba9e76141449fad1d01520c1fa959b8914282 commit refs/heads/fix/1902-inline-handler-jsarg-main origin/fix/1902-inline-handler-jsarg-main [gone]
9305d9efa36e430368d6c26bb58823e2d5dd570a commit refs/heads/fix/1946-panel-toggle-focus-main origin/fix/1946-panel-toggle-focus-main [gone]
40f7b7eb5848e12e9e4d9aa934f51a85dbf74b52 commit refs/heads/fix/1964-receipt-test-sequencing origin/fix/1964-receipt-test-sequencing [gone]
1b060218c0b41dace9c2cb4e0f2eb1f22ead90cc commit refs/heads/fix/2020-dhcp-timing-derivation origin/fix/2020-dhcp-timing-derivation [gone]
6b427ceb513cffb0690dbe0c329a0fb08a7df021 commit refs/heads/fix/2020-dryrun-a1-medusa-stub origin/fix/2020-dryrun-a1-medusa-stub [gone]
0b06f0468e2b75ef66dec82ca0060ed2561aac93 commit refs/heads/fix/2020-dryrun-a1-runbooks origin/fix/2020-dryrun-a1-runbooks [gone]
b4d4e42f0302352cdaca98cd2b2891c196a9d55a commit refs/heads/fix/2020-dryrun-a1-tooling origin/fix/2020-dryrun-a1-tooling [gone]
d8bc8b8d2874025c1a61f3112eaa77b2cd89b719 commit refs/heads/fix/2020-lease-start-mdy origin/fix/2020-lease-start-mdy [gone]
620d914e3a5eacad2399c8057c2be1f944e905c3 commit refs/heads/fix/2061-fingerprint-deadline-sentinel origin/fix/2061-fingerprint-deadline-sentinel [gone]
556c818554d62aa540e954a315a7c57c52b28b31 commit refs/heads/fix/2068-hub-plist-tmp origin/fix/2068-hub-plist-tmp [gone]
935e219b11f3804ea1118afe5f2839a9b1ba402d commit refs/heads/keep/2032-pre-rebase-20260929  
41b09ea682996d5cf4624ba388cd4d295a1012cb commit refs/heads/main origin/main [behind 404]
afa5573ed03ed096841a80ab156efb7c84237dbf commit refs/heads/wrap/20260918215717-tangleclaw-builder2  
3ad30cf11bdf129a4c885c13965d379ec8a8cc95 commit refs/heads/wrap/20260924060539-tangleclaw-builder2 origin/wrap/20260924060539-tangleclaw-builder2 [gone]
4d39273af8cd60ce9ea584cf5140b82f0da6dc6f commit refs/heads/wrap/20260926143319-tangleclaw-builder2 origin/wrap/20260926143319-tangleclaw-builder2 [gone]
4082117028af0118340eca8a1a8adf64b69e7a18 commit refs/heads/wrap/20260926184529-tangleclaw-builder2 origin/wrap/20260926184529-tangleclaw-builder2 [gone]
14e90c25d87b72739cd589488287ffab69a4dacf commit refs/heads/wrap/20260926225657-tangleclaw-builder2 origin/wrap/20260926225657-tangleclaw-builder2 
eda5e1b948c0c4129d5938c79fac6a41eb4ff2e9 commit refs/remotes/origin/HEAD  
6b6f5b9e6ccf5d1d2c9066ebd6c55a7ace5faa10 commit refs/remotes/origin/adr/0013-v7-swarm  
cc3e8364398a4f68bf3e7fc03ce5993e43954ace commit refs/remotes/origin/chore/1948-shorten-changelog  
1d15895ba112997c41564f129e384eaa2af2efa9 commit refs/remotes/origin/chore/archive-1912-plan  
d7feea57e03a93f8ee5b4fbea938d9fe0897970b commit refs/remotes/origin/chore/archive-train-2-plans  
dbdbc5b5244bd26aeeaa23a5f6bf681d95091e97 commit refs/remotes/origin/chore/remove-1444-from-manifest  
955653dbd14c96dd532c3e17f38c393610be0a38 commit refs/remotes/origin/chore/update-stale-backlog-tst-5n8w  
4aefc6343b4654253e5ee7623952588767590715 commit refs/remotes/origin/docs/1867-control-state-rollback  
067f9a199a772f8681a3fb1b5ea1d6b296a554bd commit refs/remotes/origin/docs/575-caddy-http-port  
adae8da419ef4a0f313492efe948394dc94e515d commit refs/remotes/origin/docs/features-stub-fill  
d62066077a70dfbf7962bcb8494f6e8cdc3d7546 commit refs/remotes/origin/docs/quickstart-badges  
6e234e93c2298de829427a066f7cb9ebb949712a commit refs/remotes/origin/feat/1799-c15-notify-emitter  
fff88346b608b406e576794596e4001a5e668446 commit refs/remotes/origin/feat/1799-discord-helper  
1ab70208eb3af2b526fed008cf268e0c9de7d8e7 commit refs/remotes/origin/feat/1799-discord-helper-on-2031-fold  
c144485d54648d985a1b7570aa05bee416e3593f commit refs/remotes/origin/feat/1949-c03-tc-progress  
e77dd39b6fe04bb5f29210fd2c3a1289c6339735 commit refs/remotes/origin/feat/2020-chunk4-soak-judge  
61d9585d8eeb5da77acd23429d47b149b656639b commit refs/remotes/origin/feat/993-checkout-freshness  
13f228fd31df0623948e467b39623141420db42e commit refs/remotes/origin/feat/architect-primer  
56020a83abf146b9811fc4d5e0ceaf1bea7d7c1f commit refs/remotes/origin/feat/milestone-feed  
b14f99694e5bce68ca377021833cf9021a56e29e commit refs/remotes/origin/feat/nextjs-initialization  
3efdca1ec1953de887603daefffb87fc35ec8b0c commit refs/remotes/origin/feat/operator-channel  
97c3f925d5d9179eb92a86c01c76fdc10c656a0e commit refs/remotes/origin/feat/operator-topology  
102d616b027a8c1a94c688451d2ddde4aae7db67 commit refs/remotes/origin/fix/1696-1709-rule-retirement  
5519ce0fe062cea98a693baf5fc83aa27a499517 commit refs/remotes/origin/fix/1836-codex-fullauto-loopback  
985659f8268c55b1088994d85805fd87d7b50d03 commit refs/remotes/origin/fix/1902-inline-handler-jsarg  
7558302dfc6d0e89278bd136e96ef595df0115dd commit refs/remotes/origin/fix/1937-recovery-mode-discoverability  
cb5d7b351096615b8ae4f7897c7c9640032239b4 commit refs/remotes/origin/fix/1946-panel-toggle-focus  
4c03dc403846d913617557e0d7f360cd6280f3d4 commit refs/remotes/origin/fix/1947-hooks-mkcert-trust  
39d7d5523bc3b6b782ae64f6b15147ca0019667e commit refs/remotes/origin/fix/1964-codex-receipt-test-timers  
def8489a53af812b2a673c5f1d9e72d5c70670d1 commit refs/remotes/origin/fix/1976-medusa-owed-replies  
58a26fe8f431211203380be9a2a14f497c710b50 commit refs/remotes/origin/fix/1993-scanner-routing-test  
da3efde8d9b70acbb2706166d33e4be54b35491e commit refs/remotes/origin/fix/2031-operator-channel-schema-fold  
5e8868dcc31a497948807eb67efbba87292cfe17 commit refs/remotes/origin/fix/2086-wake-scheduling  
180f0a8fa03fc7329c9bd485d8c69a5d912cf162 commit refs/remotes/origin/fix/880-default-projects-dir  
fd67100edf46676485ceafb8a62d9637a34a12ee commit refs/remotes/origin/fix/claude-socket-root  
13268a4a7e09603cea8e38091b80414726f34d3b commit refs/remotes/origin/fix/detect-idle-medusa  
c430c22f8fff72c3e918d8933f4f8a9c7db69141 commit refs/remotes/origin/fix/revert-1857  
672ef5d9b216d4ecf0bb0c6e347ca6af60ec7edf commit refs/remotes/origin/fix/ssot-back-arrow  
51c8b2dd5397b0d1243cc9e3fd8797483e035270 commit refs/remotes/origin/held/ui-freeze-1912-dashboard-a3  
eda5e1b948c0c4129d5938c79fac6a41eb4ff2e9 commit refs/remotes/origin/main  
d417747126b5369eb2b8ce482f3dbff01a04e03f commit refs/remotes/origin/wrap/20260919213124-tangleclaw-builder1  
14e90c25d87b72739cd589488287ffab69a4dacf commit refs/remotes/origin/wrap/20260926225657-tangleclaw-builder2  
c51a17f0d70fbf63f5dac8ed2a9a834c319990ac commit refs/remotes/origin/wrap/20260930003502-tc-rm08  
061d4186090688228445f23ae41fbef8b489aa71 commit refs/remotes/origin/wrap/20260930023706-tangleclaw-pr-reviewer2  
5ce8bcf3e728160cddfbb621ba7de89e2f588a6e commit refs/stash  
1aa8b30066e554a972feecaa41e3c062b6c5513a commit refs/tags/v3.13.0  
ac705d314c504626b6ee8b38047299bdba4e66af commit refs/tags/v3.13.1  
6ae09a8a78ebdc6bde14b58c469afe33c3dbc949 tag refs/tags/v3.13.2  
19a58f71d7a53124791bfe503402ea0ffc5ab6aa tag refs/tags/v3.13.3  
1f1ed1ba3777c5cd4fe297d610da3ed82c14c0e4 tag refs/tags/v3.13.4  
1cf94c3a1a1c68793fb3be89332a870cf6855a00 tag refs/tags/v3.13.5  
880db308ead397f8f139139cdd7bbb00184b4d16 tag refs/tags/v3.13.6  
abb9472c509859c242463b6d9b88603ae90ab566 tag refs/tags/v3.13.7  
ee8945a6380eb4598eb37383e98d07cc9b2760e1 tag refs/tags/v3.14.0  
6aa97c9ca8070e62a1745a6dc384292b4a6dae99 tag refs/tags/v3.15.0  
652de144491c445ada4e23ff734030fce83094e6 tag refs/tags/v3.16.0  
0114db976843e810b35434aec30f25459087d614 tag refs/tags/v3.16.1  
11b93001df0db28eba2b28cedf708e6828471f4d tag refs/tags/v3.16.2  
792b54bde0597118fce873ba447af027398773f5 tag refs/tags/v3.17.0  
2a935a399c1059c2e09355759c9a73c41318f863 tag refs/tags/v3.22.0  
a311e320d1a3cdaa7955524344e3096ef9f13b5e tag refs/tags/v3.23.0  
562146e57be3c6a36c932627115bce7454a28c80 tag refs/tags/v3.24.0  
9310981da18209fa2bf87c284eeb2fd96a5f67ae tag refs/tags/v3.25.0  
60cfaab0568939828de9b268bab2a888fa375e5f tag refs/tags/v3.26.0  
93bc4719acaae253d469c52e04a4cd20ee01f683 tag refs/tags/v3.27.0  
a308a04d242f04f402f691b45fec6612e7c586e9 tag refs/tags/v3.28.0  
d900233c315af1d9a63d889c7b1427e203188e13 tag refs/tags/v3.29.0  
e679dbf182999c45e8532b0215712046abd5fbb1 tag refs/tags/v3.32.0  
7282ed39ea29d7852d50524a48c1aee56096083a tag refs/tags/v4.0.0  
74ec80284c7e4b7d4820f942bbda7ef2dbb21a47 tag refs/tags/v4.1.0  
e6513483051082509a40c3a508fd3723169935db tag refs/tags/v4.10.0  
e1822902f95a8c685f71116827b31cafdbe29cd5 tag refs/tags/v4.11.0  
89ec31bf8bee136f4bc72739f5190c84ea15a481 tag refs/tags/v4.12.0  
16dede5a278ef8e15bff7620a0ed1aecf9f00fe6 tag refs/tags/v4.12.1  
ecb37a25e91c523340a7f8bfee8a2c4a84903f2c tag refs/tags/v4.13.0  
1584e3d7b53972dc9d7825ee5851d07402c94f06 tag refs/tags/v4.13.1  
b0bb4eb43526d2cd5f8eea501c0457141bc36930 tag refs/tags/v4.14.0  
6b6806ad95d1a65941333745b9f3fbef5bea6779 tag refs/tags/v4.15.0  
43f08566454118c18ba4448cea469beba76ff5cc tag refs/tags/v4.16.0  
2aa3c5025edc631cd8e843a0c4acc3d4bb8434f1 tag refs/tags/v4.17.0  
36628e9079244a10cb4f2ae0c3c0498fa466fcd1 commit refs/tags/v4.18.0  
364dadcae2ee43df4d481fe92258980fd95579f9 commit refs/tags/v4.18.1  
f7ed4bd828fb02960f8d64b27ceef82165c973d7 commit refs/tags/v4.18.2  
34ccfa00ba3abc7afe20e8c2acec8e2e6252946f commit refs/tags/v4.19.0  
4abfec6aabd3aa7454cd6e1af9b2b3d99b404fc7 tag refs/tags/v4.19.1  
27a2f4083728016f57dda16250b33d3a7b94dd02 tag refs/tags/v4.2.0  
f2e2931245f9787f2c89813a7a313f40ba0bdbe5 tag refs/tags/v4.2.1  
02ad09ce831ce97a9a5c29f12bed8f689d1d41b9 tag refs/tags/v4.21.0  
9d53020ab25563276bf9b9c8b04c141f955ed9e8 tag refs/tags/v4.22.0  
05398103538ab6f5f40211c9f8b45b49f51de45a tag refs/tags/v4.23.0  
eb3312268a54fc8807387ad0721b2ed4b84ee469 tag refs/tags/v4.24.0  
38caa49b9fa4469e4c5fb25df13b274309f4f5e1 tag refs/tags/v4.3.0  
28aede92767f17574a6f179d8d04f89fe38ae561 tag refs/tags/v4.30.0  
308dea761cf528e29c21abf50b8c68c2953c61e7 tag refs/tags/v4.31.0  
f3dd2404ecec8c7dfb5f6f1ed94156f1e6cf2fbe tag refs/tags/v4.31.1  
19229128b6178aea49d0bae487094066427b5d56 tag refs/tags/v4.32.0  
1dbdb91b35553e362a3d3819d5c6cecdcf2378f4 tag refs/tags/v4.32.1  
ac57477188cf89fb95a3aafeed30850ee9336956 tag refs/tags/v4.32.2  
9ee1748dc719da79d1300fb305fbdd90ad4d938b tag refs/tags/v4.33.0  
1020184d217263d23f223f539096bf9d9f4f54cf tag refs/tags/v4.34.0  
273c7fb5f1bf548b612da6e85170cf5d1ba7ff17 tag refs/tags/v4.35.0  
3e840fca11abb741bde3b5889e0491bd1863a2e5 tag refs/tags/v4.36.0  
17d3b0c0d9619522deef5152846c3e19ccfad8fc tag refs/tags/v4.37.0  
595356ca219223912df4a89e3aa6c60ee77e0eb8 tag refs/tags/v4.38.0  
cb79b64c05d9c1b81432053a5794f1ead66f3a66 tag refs/tags/v4.4.0  
249e16ed21b997741efd27a70cb786a293140ae5 tag refs/tags/v4.4.1  
4907616c60ead989c89cdc004f77956a066ba5dd tag refs/tags/v4.5.0  
fb7804bf164387977ebd72c5e99b582dd298c815 tag refs/tags/v4.5.1  
e89a5816dc8abc9dec5f2eff8a56f55593de2cc4 tag refs/tags/v4.5.2  
46ee4fc27a496c271505ce0069f3f171a96b2d4d tag refs/tags/v4.6.0  
be446f6ec2c6aa780af3faa1cfafb9ac48535b28 tag refs/tags/v4.7.0  
61de2fdad62e5f18e02a25a0e8d8dbfc6bf3684e tag refs/tags/v4.7.1  
f5d1134ce02a1a0af70532a4d5d76785f701be8f tag refs/tags/v4.8.0  
9f8adb3617505a20dbeb120c819ad9ea52670436 tag refs/tags/v4.9.0  
585a676bcc19cfc9b16379c9e899791e8c642911 tag refs/tags/v4.9.1  
54bfd716bd8c4320d4de08efbfe5e5143a8d6a9d tag refs/tags/v5.0.0  
591a04be0c04cb9ae5bd2ec2dc0811526b2ff28f tag refs/tags/v5.1.0  
a5129718814476f02d2fa64f925ac190f4c344bb tag refs/tags/v5.10.0  
e11e9bb6b43dca712942ad4677eb94dfafe051fd tag refs/tags/v5.11.0  
7a7eb87d9e2cd1392a74c104069a7f6552e3792c tag refs/tags/v5.11.1  
caab88f0b07193a110172ae4b66ce5bcbc2a6d37 tag refs/tags/v5.11.2  
a56d73e45a00b694c89c5a9663311f33b91400dd tag refs/tags/v5.12.0  
5d5edd051b6777969de8d1c677d132c9bdac00eb tag refs/tags/v5.13.0  
b8d38ab27da1da545eaa0e9037e0be736c659f9b tag refs/tags/v5.14.0  
ee0a82ac357ff1145a7f49ab10d0ad825f42a5e4 tag refs/tags/v5.14.1  
1b2ef4f778119593927bbe08fda9c9d97a8d1243 tag refs/tags/v5.15.0  
5bcee2c5889630ce6a328021a239fda5b7b723e4 tag refs/tags/v5.16.0  
d692f6b7c1b744bd5e1491329f594056b86f8271 tag refs/tags/v5.17.0  
d14f241a3aaad899de1b260d99439882523ba445 tag refs/tags/v5.18.0  
ea1a2127cb7296340ae17dd80336634b1c52fc66 tag refs/tags/v5.19.0  
bb72fcb76176cc562c3ce534aa104fd97a6f323e tag refs/tags/v5.2.0  
6bc11b6bddfb408045769f92548d164434adbe6a tag refs/tags/v5.20.0  
a9d5d4d67334929292371114721911a180b00738 tag refs/tags/v5.21.0  
41bf2d6ba54b60484829214e9c06b3259b8db160 tag refs/tags/v5.22.0  
5eddbb12d4ee0b9ac2574b23b05465b3679520fc tag refs/tags/v5.23.0  
5f2f4168a85b49b53e3ffeca755f30ae11a540c7 tag refs/tags/v5.24.0  
f73dc541a8aafb21bbff66cfeb7f4af86bfddb03 tag refs/tags/v5.25.0  
5b1f5af17cf0333eef97cb5ece80088a1b2405fd tag refs/tags/v5.25.1  
f8598b7b3d776b940ecaee9b4a66da833092837c tag refs/tags/v5.26.0  
9bb2a5528b2f04de2561e4d4acd5a6a3652e46ae tag refs/tags/v5.27.0  
73521482118028b2519860106fa8c88afb22dde4 tag refs/tags/v5.28.0  
e740846cefcd57e93d21733f8ffdf22dae45309c tag refs/tags/v5.29.0  
18e080b5f455726192d3f6973a21c9f8db3af44f tag refs/tags/v5.3.0  
8e12efa6506e9f4ad25fe022a96de682e276ec48 tag refs/tags/v5.30.0  
1892a845d35f760f421262172fbe5bb3274bf59d tag refs/tags/v5.31.0  
b04e2383cb51bf601f4026f5eb707970a766aeb5 tag refs/tags/v5.4.0  
c5f9296c5b930cc50e8946476fe717a9b4539d9f tag refs/tags/v5.5.0  
af35b1ce53b62de5c6186b96080bacaac30e6488 tag refs/tags/v5.6.0  
959533871f8ad694b123b036a4c17e921085d2bd tag refs/tags/v5.7.0  
dfb37ce32dea64c76ad3432a0f99150f3ea0d25f tag refs/tags/v5.8.0  
93fc75c905b316941d4141d3ed29200bcecb2118 tag refs/tags/v5.9.0  
```

```
$ git branch -a -vv
  backup/1628-pre-recovery-0bdab50                           0bdab503 Session wrap on fix/1628-status-row-provenance
+ docs/575-http-port-redirect-hosts                          3dd2b78d (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/575-docs) [origin/docs/575-http-port-redirect-hosts: gone] Qualify the plain-HTTP port docs by which Caddy keys are set
+ docs/features-stub-fill                                    adae8da4 (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/features-stub-fill) [origin/docs/features-stub-fill] Replace FEATURES.md's auto-stubbed TODO block with real entries
+ feat/operator-channel                                      25f03e01 (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/operator-channel) [origin/feat/operator-channel: behind 57] Correct the change-log note on the resolveOutbound comment (#1956)
  fix/1628-status-row-provenance                             0bdab503 [origin/main: ahead 7, behind 628] Session wrap on fix/1628-status-row-provenance
+ fix/1902-inline-handler-jsarg-main                         0f2ba9e7 (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1902-jsarg) [origin/fix/1902-inline-handler-jsarg-main: gone] Merge main into fix/1902-inline-handler-jsarg-main
+ fix/1946-panel-toggle-focus-main                           9305d9ef (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1946-focus) [origin/fix/1946-panel-toggle-focus-main: gone] Merge main into fix/1946-panel-toggle-focus-main
+ fix/1964-receipt-test-sequencing                           40f7b7eb (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1964-receipt) [origin/fix/1964-receipt-test-sequencing: gone] Merge remote-tracking branch 'origin/main' into fix/1964-receipt-test-sequencing
+ fix/2020-dhcp-timing-derivation                            1b060218 (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dhcp) [origin/fix/2020-dhcp-timing-derivation: gone] Archive shipped change-log history past the size threshold
+ fix/2020-dryrun-a1-medusa-stub                             6b427ceb (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c3) [origin/fix/2020-dryrun-a1-medusa-stub: gone] Preview the softnet closure before running it, and say how to find the guest after it
+ fix/2020-dryrun-a1-runbooks                                0b06f046 (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c2) [origin/fix/2020-dryrun-a1-runbooks: gone] Give the closure the same display as the first boot, and say why the default stays
+ fix/2020-dryrun-a1-tooling                                 b4d4e42f (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1) [origin/fix/2020-dryrun-a1-tooling: gone] Correct the #2020 Chunk 1 records: name the refusal detail and the hub decision
+ fix/2020-lease-start-mdy                                   d8bc8b8d (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-lease-start) [origin/fix/2020-lease-start-mdy: gone] Say the ipconfig forms were confirmed on a real guest; point the F5/F6 deferral at #2064
+ fix/2061-fingerprint-deadline-sentinel                     620d914e (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2061) [origin/fix/2061-fingerprint-deadline-sentinel: gone] Classify a fingerprint timeout by what ended the call, not by re-reading the clock (#2061)
+ fix/2068-hub-plist-tmp                                     556c8185 (/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2068-hub-tmp) [origin/fix/2068-hub-plist-tmp: gone] Record the stub hub plist fix in the change-log
  keep/2032-pre-rebase-20260929                              935e219b Bind a relaunched coordinator only to its own recorded thread, and show the binding (#2032)
* main                                                       41b09ea6 [origin/main: behind 404] Merge pull request #1920 from Jason-Vaughan/fix/1905-tailnet-cutover
  wrap/20260918215717-tangleclaw-builder2                    afa5573e Session wrap on wrap/20260918215717-tangleclaw-builder2
  wrap/20260924060539-tangleclaw-builder2                    3ad30cf1 [origin/wrap/20260924060539-tangleclaw-builder2: gone] Session wrap on wrap/20260924060539-tangleclaw-builder2
  wrap/20260926143319-tangleclaw-builder2                    4d39273a [origin/wrap/20260926143319-tangleclaw-builder2: gone] Session wrap on wrap/20260926143319-tangleclaw-builder2
  wrap/20260926184529-tangleclaw-builder2                    40821170 [origin/wrap/20260926184529-tangleclaw-builder2: gone] Session wrap on wrap/20260926184529-tangleclaw-builder2
  wrap/20260926225657-tangleclaw-builder2                    14e90c25 [origin/wrap/20260926225657-tangleclaw-builder2] Session wrap on wrap/20260926225657-tangleclaw-builder2
  remotes/origin/HEAD                                        -> origin/main
  remotes/origin/adr/0013-v7-swarm                           6b6f5b9e docs(adr): plant the flag for v7 Swarm Architecture & TangleBrain
  remotes/origin/chore/1948-shorten-changelog                cc3e8364 chore: condense [Unreleased] under the release-notes ceiling (#1948)
  remotes/origin/chore/archive-1912-plan                     1d15895b Archive the Fleet Workload Phase A plan
  remotes/origin/chore/archive-train-2-plans                 d7feea57 Archive the shipped 1637, 1885 and Train 2 plans
  remotes/origin/chore/remove-1444-from-manifest             dbdbc5b5 docs(design): initiate hierarchical workflow brain dump (#1749)
  remotes/origin/chore/update-stale-backlog-tst-5n8w         955653db chore: update stale backlog status for TST-5N8W
  remotes/origin/docs/1867-control-state-rollback            4aefc634 Say that control state survives a rollback and reasserts on re-upgrade
  remotes/origin/docs/575-caddy-http-port                    067f9a19 Say which hosts the plain-HTTP port redirects (#575)
  remotes/origin/docs/features-stub-fill                     adae8da4 Replace FEATURES.md's auto-stubbed TODO block with real entries
  remotes/origin/docs/quickstart-badges                      d6206607 docs(readme): add 1-click quickstart snippet and status badges
  remotes/origin/feat/1799-c15-notify-emitter                6e234e93 Drop an orphan #1053 heading the C1 main-merge left in the change-log (#1799)
  remotes/origin/feat/1799-discord-helper                    fff88346 Never repost a Discord reply an earlier attempt may have posted (#1799)
  remotes/origin/feat/1799-discord-helper-on-2031-fold       1ab70208 Settle a held Discord reply completely and truthfully, and record a rejected one as discarded (#1799)
  remotes/origin/feat/1949-c03-tc-progress                   c144485d Point the #1949 C03 change-log at the suite run on its final code commit
  remotes/origin/feat/2020-chunk4-soak-judge                 e77dd39b Make the soak judge honour sealed records and name every damaged input (#2020)
  remotes/origin/feat/993-checkout-freshness                 61d9585d docs(plan): A1 adds no workflow block; halt for Hotfix B.1 (#993)
  remotes/origin/feat/architect-primer                       13f228fd feat: track the architect priming prompt
  remotes/origin/feat/milestone-feed                         56020a83 feat: implement read-only TangleClaw milestone feed
  remotes/origin/feat/nextjs-initialization                  b14f9969 feat(website): Render visible screenshot gallery for Anthropic submission
  remotes/origin/feat/operator-channel                       3efdca1e Relay only a project launch's own sends to the operator's chat (#1956)
  remotes/origin/feat/operator-topology                      97c3f925 feat: inject operator host topology into session prime (fixes #1178)
  remotes/origin/fix/1696-1709-rule-retirement               102d616b Mark the chunk 1-3 'retire needs no password' notes as superseded by the N1 ruling
  remotes/origin/fix/1836-codex-fullauto-loopback            5519ce0f Merge pull request #1974 from Jason-Vaughan/fix/1957-loopback-guard
  remotes/origin/fix/1902-inline-handler-jsarg               985659f8 Record the #1902 test-harness commit in its change-log entry
  remotes/origin/fix/1937-recovery-mode-discoverability      7558302d Complete the #1937 nudge sentence and pin the entry's evidence to the final run
  remotes/origin/fix/1946-panel-toggle-focus                 cb5d7b35 Record the #1946 adjacency test in its change-log entry
  remotes/origin/fix/1947-hooks-mkcert-trust                 4c03dc40 Record the #1947 change-log entry
  remotes/origin/fix/1964-codex-receipt-test-timers          39d7d552 Record the #1964 change-log entry
  remotes/origin/fix/1976-medusa-owed-replies                def8489a chore(prawduct): change-log entry for #1976 Chunk 01
  remotes/origin/fix/1993-scanner-routing-test               58a26fe8 Merge origin/main into fix/1993-scanner-routing-test
  remotes/origin/fix/2031-operator-channel-schema-fold       da3efde8 Harden the operator channel: bound the sender id, name every conflict target, prove the key index at boot, and report undelivered messages (#2031)
  remotes/origin/fix/2086-wake-scheduling                    5e8868dc Stop a slow or hung pane holding up the Medusa wakes scanned after it (#2086)
  remotes/origin/fix/880-default-projects-dir                180f0a8f Pin the #880 entry's evidence to the final tree rather than an earlier run
  remotes/origin/fix/claude-socket-root                      fd67100e chore(prawduct): change-log entry for #1904
  remotes/origin/fix/detect-idle-medusa                      13268a4a fix: rewire detectIdle to use Medusa at-rest intelligence
  remotes/origin/fix/revert-1857                             c430c22f Revert "[fix] Restore Architect Primer to plans directory (#1857)"
  remotes/origin/fix/ssot-back-arrow                         672ef5d9 Refactor SSOT back link to use optional project config
  remotes/origin/held/ui-freeze-1912-dashboard-a3            51c8b2dd Record the boundary-review fixes in the Phase A change-log entry
  remotes/origin/main                                        eda5e1b9 Merge pull request #2114 from Jason-Vaughan/release/v5.31.0-promotion
  remotes/origin/wrap/20260919213124-tangleclaw-builder1     d4177471 Resolve the wrap conflict by keeping what main already landed
  remotes/origin/wrap/20260926225657-tangleclaw-builder2     14e90c25 Session wrap on wrap/20260926225657-tangleclaw-builder2
  remotes/origin/wrap/20260930003502-tc-rm08                 c51a17f0 Session wrap on wrap/20260930003502-tc-rm08
  remotes/origin/wrap/20260930023706-tangleclaw-pr-reviewer2 061d4186 Session wrap on wrap/20260930023706-tangleclaw-pr-reviewer2
```

```
$ git worktree list --porcelain
worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2
HEAD 41b09ea682996d5cf4624ba388cd4d295a1012cb
branch refs/heads/main

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1902-jsarg
HEAD 0f2ba9e76141449fad1d01520c1fa959b8914282
branch refs/heads/fix/1902-inline-handler-jsarg-main

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1946-focus
HEAD 9305d9efa36e430368d6c26bb58823e2d5dd570a
branch refs/heads/fix/1946-panel-toggle-focus-main

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/1964-receipt
HEAD 40f7b7eb5848e12e9e4d9aa934f51a85dbf74b52
branch refs/heads/fix/1964-receipt-test-sequencing

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dhcp
HEAD 1b060218c0b41dace9c2cb4e0f2eb1f22ead90cc
branch refs/heads/fix/2020-dhcp-timing-derivation

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1
HEAD b4d4e42f0302352cdaca98cd2b2891c196a9d55a
branch refs/heads/fix/2020-dryrun-a1-tooling

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c2
HEAD 0b06f0468e2b75ef66dec82ca0060ed2561aac93
branch refs/heads/fix/2020-dryrun-a1-runbooks

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1-c3
HEAD 6b427ceb513cffb0690dbe0c329a0fb08a7df021
branch refs/heads/fix/2020-dryrun-a1-medusa-stub

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-lease-start
HEAD d8bc8b8d2874025c1a61f3112eaa77b2cd89b719
branch refs/heads/fix/2020-lease-start-mdy

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2061
HEAD 620d914e3a5eacad2399c8057c2be1f944e905c3
branch refs/heads/fix/2061-fingerprint-deadline-sentinel

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2068-hub-tmp
HEAD 556c818554d62aa540e954a315a7c57c52b28b31
branch refs/heads/fix/2068-hub-plist-tmp

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/575-docs
HEAD 3dd2b78d516c7bd672928722f7ea5153b7673eba
branch refs/heads/docs/575-http-port-redirect-hosts

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/ci-aea0c4f8
HEAD aea0c4f8e1ff8abe2f4d1bebaa9d582a0a228f91
detached

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/features-stub-fill
HEAD adae8da419ef4a0f313492efe948394dc94e515d
branch refs/heads/docs/features-stub-fill

worktree /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/operator-channel
HEAD 25f03e0185887b6776adee5291a172301c4fe980
branch refs/heads/feat/operator-channel

```

## 3. Main checkout status

```
$ git status
On branch main
Your branch is behind 'origin/main' by 404 commits, and can be fast-forwarded.
  (use "git pull" to update your local branch)

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   CLAUDE.md
	modified:   FEATURES.md

no changes added to commit (use "git add" and/or "git commit -a")
```

```
$ git status --porcelain=v2 --branch --untracked-files=all
# branch.oid 41b09ea682996d5cf4624ba388cd4d295a1012cb
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -404
1 .M N... 100644 100644 100644 d90af1b1e47e7faeb7248e9d00c0df2c1eae208e d90af1b1e47e7faeb7248e9d00c0df2c1eae208e CLAUDE.md
1 .M N... 100644 100644 100644 c2962907d1ff6a020f6f6730fdcad8cead4c554c c2962907d1ff6a020f6f6730fdcad8cead4c554c FEATURES.md
```

```
$ git diff --stat
 CLAUDE.md   |  4 +++-
 FEATURES.md | 13 +++++--------
 2 files changed, 8 insertions(+), 9 deletions(-)
```

## 4. Stash

```
$ git stash list
stash@{0}: WIP on main: 41b09ea6 Merge pull request #1920 from Jason-Vaughan/fix/1905-tailnet-cutover
```

```
$ git stash list --format='%H %gd %ci %gs'
5ce8bcf3e728160cddfbb621ba7de89e2f588a6e stash@{0} 2026-09-29 07:12:24 -0700 WIP on main: 41b09ea6 Merge pull request #1920 from Jason-Vaughan/fix/1905-tailnet-cutover
```

```
$ git stash show --stat stash@{0}
 CLAUDE.md   |  4 +++-
 FEATURES.md | 21 +++++++++++++--------
 2 files changed, 16 insertions(+), 9 deletions(-)
```
