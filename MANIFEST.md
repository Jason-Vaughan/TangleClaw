# v5.29 cleanup — preservation archive, TangleClaw-Builder2 checkout

Built 2026-10-06T16:04:06Z by the Builder2 session from `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2`, on direct PM dispatch (Medusa e2d5db21, 2026-10-06), which states the operator authorized it. It preserves local-only state from that checkout before any worktree is retired. Nothing in the checkout was changed to build it: no commit, reset, stash operation or deletion.

`SHA256SUMS` lists every file here. Verify with `shasum -a 256 -c SHA256SUMS`.

## root-dirty/ — uncommitted edits in the main checkout

Branch `main` at `41b09ea682996d5cf4624ba388cd4d295a1012cb`, with unstaged edits to `CLAUDE.md` and `FEATURES.md` that were on no ref.

- `main-41b09ea6-dirty.patch` — `git diff --binary HEAD`. Verified: applied to those two files at HEAD it reproduces the working copies byte for byte.
- `working-copies/` — the two files exactly as they stood.
- `status.txt`, `status.porcelain-v2.txt`, `diffstat.txt`, `HEAD.txt` — the state they were taken from.

## stash/ — the one shared stash entry

Stash commit `5ce8bcf3e728160cddfbb621ba7de89e2f588a6e` ("WIP on main: 41b09ea6", 2026-09-29). The stash stack is shared by every worktree of the clone; its author is unknown to the session that archived it. The stash itself was not touched.

- `stash-5ce8bcf3-worktree-vs-base.patch` — `git diff --binary <stash>^1 <stash>`. Verified: applied to base `41b09ea6` it reproduces the stashed files byte for byte.
- `stash-5ce8bcf3-index-vs-base.patch` — `git diff --binary <stash>^1 <stash>^2`. Empty: nothing was staged.
- `stashed-copies/` — the stashed versions of the files it touches.
- `stash-metadata.txt` — stash list, the raw stash and index commit objects, tree and parent ids, and the stash reflog. Two parents only, so it holds no untracked files.

## evidence/ — gitignored `.prawduct/` files, per worktree

Every file `git status --ignored --untracked-files=all` reported under `.prawduct/`, copied with its relative path. These are review ledgers, Critic findings, PR-review and test evidence, handoff notes and local plans. `git worktree remove` deletes them without refusing, which is why they are here. Each copy was compared with its source byte for byte.

| Directory | Source worktree | Branch at archive time | Entries |
|---|---|---|---|
| `evidence/1902-jsarg/` | `.claude/worktrees/1902-jsarg` | `fix/1902-inline-handler-jsarg-main @ 0f2ba9e7` | 4 |
| `evidence/1946-focus/` | `.claude/worktrees/1946-focus` | `fix/1946-panel-toggle-focus-main @ 9305d9ef` | 5 |
| `evidence/1964-receipt/` | `.claude/worktrees/1964-receipt` | `fix/1964-receipt-test-sequencing @ 40f7b7eb` | 6 |
| `evidence/2020-dhcp/` | `.claude/worktrees/2020-dhcp` | `fix/2020-dhcp-timing-derivation @ 1b060218` | 6 |
| `evidence/2020-dryrun-a1/` | `.claude/worktrees/2020-dryrun-a1` | `fix/2020-dryrun-a1-tooling @ b4d4e42f` | 8 |
| `evidence/2020-dryrun-a1-c2/` | `.claude/worktrees/2020-dryrun-a1-c2` | `fix/2020-dryrun-a1-runbooks @ 0b06f046` | 6 |
| `evidence/2020-dryrun-a1-c3/` | `.claude/worktrees/2020-dryrun-a1-c3` | `fix/2020-dryrun-a1-medusa-stub @ 6b427ceb` | 7 |
| `evidence/2020-lease-start/` | `.claude/worktrees/2020-lease-start` | `fix/2020-lease-start-mdy @ d8bc8b8d` | 6 |
| `evidence/2061/` | `.claude/worktrees/2061` | `fix/2061-fingerprint-deadline-sentinel @ 620d914e` | 3 |
| `evidence/2068-hub-tmp/` | `.claude/worktrees/2068-hub-tmp` | `fix/2068-hub-plist-tmp @ 556c8185` | 6 |
| `evidence/operator-channel/` | `.claude/worktrees/operator-channel` | `feat/operator-channel @ 25f03e01` | 8 |
| `evidence/root-main-checkout/` | `(main checkout)` | `main @ 41b09ea6` | 20 |

Worktrees with no ignored `.prawduct/` files, so no directory here: `575-docs`, `ci-aea0c4f8`, `features-stub-fill`.

Three entries are symbolic links, archived as links. Their targets are plan files in the `2020-dryrun-a1` worktree, whose real content is under `evidence/2020-dryrun-a1/`:

- `evidence/2020-dryrun-a1-c3/.prawduct/artifacts/2020-medusa-stub-hub-spec.md` → `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1/.prawduct/artifacts/2020-medusa-stub-hub-spec.md`
- `evidence/2020-dryrun-a1-c3/.prawduct/artifacts/build-plan.md` → `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1/.prawduct/artifacts/build-plan.md`
- `evidence/2020-dryrun-a1-c2/.prawduct/artifacts/build-plan.md` → `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.claude/worktrees/2020-dryrun-a1/.prawduct/artifacts/build-plan.md`

Not archived here: the main checkout also has gitignored files outside `.prawduct/` (engine and local settings and the like). The dispatch covered `.prawduct/` evidence only.

## What is preserved elsewhere

Three annotated tags on `origin` hold the commits that existed on no remote branch:

| Tag | Commit | What |
|---|---|---|
| `archive/builder2/1628-status-row-provenance` | `0bdab503` | `fix/1628-status-row-provenance` and its alias `backup/1628-pre-recovery-0bdab50`: seven commits, never merged, includes a WIP checkpoint. Do not merge. |
| `archive/builder2/wrap-20260918215717` | `afa5573e` | One session-wrap bookkeeping commit with no PR. |
| `archive/builder2/2032-pre-rebase-20260929` | `935e219b` | Pre-rebase snapshot of merged PR #2038; commit `be9bb6b8` is not patch-equivalent on main. |

## Privacy check before publishing

Scanned for credential patterns, bearer tokens, key=value secrets, private keys, bcrypt hashes and JWTs: none. The one token-shaped string is a fake fixture name inside a test report, and it is already in the public test suite. The archive does contain this machine's short hostname in one test report and local absolute paths; the tailnet name and those paths are already public on `main`.
