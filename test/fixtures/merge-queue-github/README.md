# Recorded GitHub exchanges for `lib/merge-queue-github.js`

Each `.json` file here is one `gh api -i` call made against
`Jason-Vaughan/TangleClaw` on 2026-10-12 (`capturedAt` in each file), with the
arguments it sent (`args`), the exit code, the HTTP status line, the body after
the response headers, and what `gh` wrote to stderr. The response headers are
not kept. `test/merge-queue-github.test.js` replays them in place of `gh`.
They come from two sittings.

**The first sitting (07:18 UTC)** was run when a candidate was still merged on
its own `tc-queue/` branch: one throwaway branch, created at `6ee1f14b` (`main`
before pull request #2331), with `1aa8f5de` (that pull request's head) merged
into it, then deleted. Its real name carried the time it was made; in these
files it reads `tc-queue/probe-20261012-000000`. Nothing was merged into
`main`. The merge commit GitHub made on the branch has the same tree as `main`'s
own merge of that pull request (`commit-candidate.json` and
`commit-main-merge.json`). Three of its write answers are still replayed for a
call the module now sends to another branch: `ref-create-exists.json` (the
answer to creating a branch that is already there), and `merge-nothing.json`
and `merge-conflict.json`, which the probe script sent itself, to the same
endpoint with a commit message of its own and no `--jq`. Their answers carry no
branch name and no projected body, so they read the same either way. Its two
recordings of calls the module no longer makes (a `tc-queue/` branch created at
the base, and a merge into it) were removed.

**The second sitting (09:26 UTC)** is one candidate made the way the module
makes it now, by `createCandidate` and then `discardCandidate`, with every call
the module's own: the stage branch `tc-queue-stage/probe-20261012-092611`
created at `43e13e78` (`main` before pull request #2335), `ccfe717f` (that pull
request's head) merged into it, the merge commit `48774bab` read back, the
candidate branch `tc-queue/probe-20261012-092611` created at it, the stage
branch deleted; then the candidate branch deleted and the stage branch found
already gone. The names are the real ones. Nothing was merged into `main`, and
the merge commit has the tree of `main`'s own merge of that pull request
(`380674d0`).

| File | The call | Answer |
|---|---|---|
| `pull-merged.json` | read pull request #2331, merged | 200 |
| `pull-open-draft.json` | read pull request #2217, an open draft | 200 |
| `pull-not-found.json` | read a pull request that does not exist | 404 |
| `pull-files-page.json` | the one page of #2331's changed files | 200 |
| `ref-main.json` | read the tip of `main` | 200 |
| `ref-not-found.json` | read a branch that never existed | 404 |
| `ref-candidate.json` | read the probe branch after the merge | 200 |
| `ref-candidate-gone.json` | read the probe branch after its deletion | 404 |
| `commit-main-merge.json` | read `main`'s merge of #2331 | 200 |
| `commit-candidate.json` | read the probe branch's merge commit | 200 |
| `compare-main-merge.json` | files between `6ee1f14b` and `main`'s merge | 200 |
| `compare-candidate.json` | files between `6ee1f14b` and the probe's merge | 200 |
| `compare-identical.json` | a commit compared with itself | 200 |
| `compare-diverged.json` | two commits neither of which contains the other | 200 |
| `ref-create-exists.json` | create the first probe branch a second time | 422 |
| `merge-nothing.json` | merge `1aa8f5de` into it a second time | 204 |
| `merge-conflict.json` | merge a commit that conflicts (`cc3e8364`) into it | 409 |
| `ref-deleted.json` | delete the first probe branch | 204 |
| `ref-delete-missing.json` | delete it a second time | 422 |
| `stage-ref-created.json` | create the stage branch at `43e13e78` | 201 |
| `stage-merge-created.json` | merge `ccfe717f` into the stage branch | 201 |
| `stage-merge-read.json` | read that merge commit back | 200 |
| `candidate-ref-created.json` | create the candidate branch at the merge commit | 201 |
| `stage-ref-deleted.json` | delete the stage branch | 204 |
| `candidate-ref-deleted.json` | delete the candidate branch | 204 |
| `stage-ref-delete-missing.json` | delete the stage branch a second time | 422 |

`pull-merge-DOCUMENTED.json` is the one file that is **not** a recording: see
the note inside it.
