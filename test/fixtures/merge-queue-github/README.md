# Recorded GitHub exchanges for `lib/merge-queue-github.js`

Each `.json` file here is one `gh api -i` call the module itself made against
`Jason-Vaughan/TangleClaw` on 2026-10-12 (`capturedAt` in each file), with the
arguments it sent (`args`), the exit code, the HTTP status line, the body after
the response headers, and what `gh` wrote to stderr. The response headers are
not kept. `test/merge-queue-github.test.js` replays them in place of `gh`.

The write calls come from one throwaway branch, created at `6ee1f14b` (`main`
before pull request #2331), with `1aa8f5de` (that pull request's head) merged
into it, then deleted. Its real name carried the time it was made; in these
files it reads `tc-queue/probe-20261012-000000`. Nothing was merged into
`main`. The merge commit GitHub made on the branch has the same tree as `main`'s
own merge of that pull request (`commit-candidate.json` and
`commit-main-merge.json`).

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
| `ref-created.json` | create the probe branch | 201 |
| `merge-created.json` | merge `1aa8f5de` into it | 201 |
| `ref-create-exists.json` | create the probe branch a second time | 422 |
| `merge-nothing.json` | the same merge a second time | 204 |
| `merge-conflict.json` | merge a commit that conflicts (`cc3e8364`) | 409 |
| `ref-deleted.json` | delete the probe branch | 204 |
| `ref-delete-missing.json` | delete it a second time | 422 |

`pull-merge-DOCUMENTED.json` is the one file that is **not** a recording: see
the note inside it.
