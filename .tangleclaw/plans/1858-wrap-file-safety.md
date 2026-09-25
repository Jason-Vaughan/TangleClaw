# #1858 — Wrap file decisions fail closed, with safe recommendations

*Pilot 4 Builder lane (TangleClaw-Pilot-B1). Branch `fix/1858-wrap-file-safety`, fresh off `origin/main` @5ab699bc.
Dispatched by the PM on 2026-09-25.*

## Status

- [x] Plan written, and design items A1–A8 sent to the Architect (dispatch boundary: "Stop at PLAN WRITTEN")
- [x] Architect ruled on A1–A8 (2026-09-25): A1, A3, A5 and A6 approved; A2 and A4 approved with
  constraints; A7 modified; A8 rejected
- [x] Architect ruled on deleted protected paths (2026-09-25; see Design → Deletions)
- [x] Plan correction 2bc8fe4e acknowledged by the Architect. The audit approved salvage with one bounded
  remediation (deletions by name), and the PM released only that remediation (2026-09-25)
- [x] Deletion ruling implemented and tested: the blanket exemption is removed, deletions are judged by name, and
  the four deletion tests replace the old one
- [x] Draft PR #1860 brought in line with this plan and pushed (9a416b08). The evidence went to the PM, and the Architect's
  audit PASSED the deletion remediation (2026-09-25)
- [x] Final acceptance correction (PM release, 2026-09-25): ignore suggestions escape every trailing space, and a
  path containing CR/LF gets no suggestion. Two focused tests. 683b9f3a, verify-resolutions 0 findings. **STOP**,
  PR still a draft. The independent PR review is dispatched by the PM next

**Pilot envelope (IN FORCE):** no merging any PR, no pulling/updating the live checkout, no restarting the
live service, no tests on the main instance, no tag/publish/release, no deploy.

### Deviation record (2026-09-25)

The Architect's plan-correction hold (04:22:43Z) and the deletion objection and stop (04:25:10Z), plus the
PM's stop (04:25:38Z), were queued on the switchboard. **This session was not notified of them until after
it had acted on the PM's go-ahead of 04:22:05Z.** In that window, Chunks 01–03 were built and committed
(1b4b7e56, 2ae024a9, 0ab0703c, review fix ad78b50c, merge of `main` 26f58769), pushed, and opened as
**draft** PR #1860. Nothing was merged. That work predates this corrected plan. One part of it conflicts with
the plan: deletions are exempt from the protected rule across the board, where the ruling below withholds a
name-matched deletion. That was corrected in 250203e0 under the PM's bounded release (see Status). Per instruction, nothing was reverted or discarded.

## Problem

`session-files` (`lib/wrap-steps/session-files.js`) presented every never-committed file (`untracked-new`,
`lib/wrap-steps/_file-ownership.js`) as an equal Include/Leave choice with no recommendation
(`renderPathDecisionWidget`, `public/session.js`). In the incident, a PM wrap asked about six new files. The
operator chose Include for all six, which put a runtime SQLite file and three `scratch/` files in the
selection. Only the CHANGELOG gate stopped it, and that gate is not a file-safety gate: an `### Internal`
entry would have cleared it. `SECURITY.md` says the runtime database holds remote-service tokens in
plaintext.

What the code had before this work (verified 2026-09-25):

- **No safety class existed.** `classify` sorted files by *who* changed them (owned/foreign) and never by
  *what* the file is. `lib/` had no SQLite detection.
- **Decisions were sanitized, not validated.** `sanitizeDecisions` keeps any `include`/`leave` for any path.
  The commit step re-classifies, but it honored any Include it received.
- **Every Retry re-runs the pipeline from `session-files`**, and the accumulated `pathDecisions` ride along in
  `options` (`H.accumulatePathDecisions`, `public/wrap-drawer.js`).
- **Precedents:** `_secret-check.js` withholds a flagged file and folds it into the same decision list.
  `lib/project-heal.js` writes a delimited block into `.git/info/exclude` (never `.gitignore`).

## Confidence check

1. **Problem:** a runtime database or scratch output is one ordinary radio click away from a public wrap
   commit, and nothing tells the operator which choice is safe.
2. **Success:** the issue's seven acceptance tests pass, plus the Architect's required tests. On the incident
   tree, only the two plans are recommended for Include. Applying the recommendations never stages the
   SQLite file or the scratch files. No option, whether replayed, stale or forged, can stage a protected
   file.
3. **Out of scope:**
   - the ownership rules (owned/foreign), the secret scan's own rules, and the un-track offer
   - `lib/wrap-handback.js` (A8 was rejected)
   - reading historical blobs
   - writing `.gitignore` or `.git/info/exclude`
   - deleting any file (Keep local is Leave, which never touches disk)

Requirements confidence: **High**. The Architect has ruled on every shape question.

## Design

### Classes — `lib/wrap-steps/_file-safety.js`

`safetyOf(root, relPath) → { class, recommendation, why }`, where `class` is one of the following, checked in
this order:

| class | matched by | recommendation | may be Included? |
|---|---|---|---|
| `local` (exception) | the basenames `Thumbs.db` and `.DS_Store`, in any case. Checked **before** the database rule, because `Thumbs.db` ends in `.db` | Keep local (recommended) | yes, by explicit choice |
| `protected` | extension `.sqlite`/`.sqlite3`/`.db`/`.db3` in any case; a `-wal`/`-shm`/`-journal` sidecar **of a database name**; the known runtime paths `data/tangleclaw.db` and `data/tangleclaw.sqlite`; or the 16-byte SQLite header, read only after `lstat` shows a regular file (symlinks are never followed) | none. It is withheld and never offered | **no** (A3) |
| `local` | root-level `scratch/`, `tmp/`, `temp/`, `cache/`, `logs/`, `coverage/`; `node_modules/` and `.cache/` as any path segment; suffixes `.log`, `.tmp`, `.swp`, `~` in any case | Keep local (recommended) | yes, by explicit choice |
| `durable` | `.tangleclaw/plans/**/*.md`, `.tangleclaw/priming/*.md`, `.tangleclaw/memories/*.md` | Include (recommended) | yes |
| `ambiguous` | everything else, including new source such as `lib/cache/adapter.js` and `src/tmp/parser.js` | none; the operator decides | yes |

### Enforcement — `_file-ownership.classify`

The safety pass runs after the existing TangleClaw state/maintenance handling and before the owner rules and
any decision:

1. **A protected path is withheld from every bucket** (owned, foreign, tracked, untracked) into
   `safetyWithheld`. It is never stageable and never offered as a choice. An `include` for it is ignored and
   recorded in `refusedIncludes`. Both lists appear in the step output and in the audit trail, and the output
   says visibly that the Include was ignored.
2. **Deletions** (Architect ruling, 2026-09-25):
   - A deletion whose **path or name** matches a protected rule (a `.db`/`.sqlite` extension, a database
     sidecar, or a known runtime path) is **withheld** like any other protected path. The name is enough;
     nothing is read.
   - A deletion of a file that was protected **only by its header**, under an ambiguous name, follows the
     normal ownership rules. There is no working-tree content to publish, and reading historical blobs is
     out of scope.
3. **Every other asked-about path** carries `kind`, an advisory `recommendation` (`include` | `leave` | `null`)
   and `recommendationWhy` on its `foreignPaths` entry. The server never turns a recommendation into a
   decision, and no radio is preselected. A file that matches a secret rule is never recommended for Include
   (`_secret-check.check` clears it, and the drawer ignores one if it arrives anyway).
4. **The commit step re-runs `classify`**, so UI state, replayed or forged options, and AI output cannot stage a
   protected path. A protected file that is already staged in the real index stays staged and outside the
   wrap's pathspec commit.
5. **`changelog-coverage`** adds `safetyWithheld` to its excluded set, so a CHANGELOG entry can never be what a
   withheld file is waiting on. No handback gate is involved.

### Manifest — the pre-Retry contract

`manifestOf` produces `{commit, keepLocal, protected, unresolved, refusedIncludes}` as exact paths. Both
`session-files` and `commit` emit it.

- **Before the click:** while `session-files` (or `commit`) is blocked on decisions, the decision surface shows
  the manifest **projected** from the current answers, with each unanswered file taking its recommendation.
  It is shown under four groups (commit, keep local, protected, unresolved ambiguous) and is repainted as
  answers change.
- **The confirmation:** pressing **Apply recommendations and retry** is the confirmation. There is no extra
  pause, because A3 permits no override.
- **After the click:** the settled `session-files` and `commit` rows repeat the manifest for audit.

### Drawer — `public/wrap-drawer.js`, `public/session.js`

- Each asked-about file shows its recommendation as text beside two unchecked radios.
- Protected paths have **no radio**. They are named in a note that says a wrap never commits a database, and
  that the escape is a **separate ordinary commit outside the wrap**. Refused Includes are named there too.
- **Apply recommendations and retry** is client-side and uses the existing decisions and the existing Retry
  route. It fills only unanswered files that have a recommendation, never overwrites an explicit choice, and
  says how many files still need a choice.
- When results return, the client prunes protected paths from its accumulated `pathDecisions` map.
- **Ignore suggestions** (A6) are text only, and each is exact and anchored:
  - A root-level local directory line (`/scratch/`) is offered only when git tracks nothing under it and no
    ambiguous or undecided file sits in it.
  - Otherwise the line is the exact file (`/data/tangleclaw.sqlite`). `data/` is never suggested.
  - Gitignore syntax in a path is escaped.

## Decision record

What was proposed, and the Architect's ruling of 2026-09-25. The ruling is what the Design above implements.

- **A1** (a separate `_file-safety.js`): **approved**.
- **A2** (protected applies across buckets): **approved with constraints**:
  - the `Thumbs.db` exception
  - case-insensitive suffixes
  - sidecars tied to a database name
  - `lstat` before any header read, and no symlink follow
  - the required already-staged test

  **Extended** later the same day by the deletion ruling (Design → Enforcement 2).
- **A3** (no in-wrap override): **approved**. The escape is a separate ordinary commit outside the wrap.
- **A4** (recommendations are advisory): **approved with a modification**:
  - generic runtime directory names count as local only at the repository root
  - `node_modules` and `.cache` count at any depth
  - the negative tests are required
- **A5** (client-side Apply over the existing route): **approved**.
- **A6** (ignore suggestions are text only): **approved**. A directory line is allowed only when it cannot hide
  tracked or ambiguous contents.
- **A7** (manifest): **modified**. It must be visible before the Apply click (Design → Manifest). The proposal
  to show it only on completed rows was rejected.
- **A8** (a handback refusal on `refusedIncludes`): **rejected**. `lib/wrap-handback.js` is out of scope.
- **Assumptions**, all approved:
  - both `data/tangleclaw.db` and `data/tangleclaw.sqlite` are known runtime paths
  - new source is ambiguous
  - `durable` is limited to the three `.tangleclaw/` Markdown areas
- **Standing instruction:** send any newly discovered architectural choice to the Architect before
  implementing it.

## Chunks

`partition: serial — 02 renders the fields 01 adds; 03 documents both.`

### Chunk 01 — classifier and server enforcement

The new `lib/wrap-steps/_file-safety.js`, plus edits to `_file-ownership.js` (the safety pass, `manifestOf`),
`session-files.js`, `commit.js`, `changelog-coverage.js` and `_secret-check.js` (no Include recommendation for a
secret match).

**Tests:** `test/wrap-file-safety.test.js`.

- **Classifier boundaries:**
  - the `Thumbs.db` exception
  - sidecars tied to a database name
  - a header match under a non-database name
  - a symlink is never followed
  - `lib/cache/adapter.js` and `src/tmp/parser.js` stay ambiguous
- **The incident tree recommends Include only for the two plans.**
- **Apply-equivalent decisions** commit the plans and leave the database and the scratch files on disk.
- **Include for every file**, or a forged Include sent straight to `commit`, stages neither the database nor its
  `-wal`, and both appear in `refusedIncludes`.
- **A protected file already staged in the index** stays staged and uncommitted.
- **`changelog-coverage`** excludes a withheld database.
- **A new `lib/` file** stays an unrecommended question.
- **A secret-flagged plan** is not recommended for Include.
- **Deletions (the new ruling):**
  - A deleted tracked `.db`, a deleted `data/tangleclaw.sqlite` and a deleted database sidecar are **withheld**
    (still in HEAD, not committed).
  - A deleted, header-only database under an ambiguous name is committed as a deletion by the normal rules.

### Chunk 02 — drawer

Edits to `public/wrap-drawer.js` (the descriptor fields, `recommendationLabel`, `projectManifest`,
`recommendationsToApply`, `pruneProtectedDecisions`, `rowManifest`), `public/session.js` (rendering, the
projected manifest, the Apply button) and `public/session.css`.

- **Tests:** `test/wrap-drawer.test.js`:
  - no Include recommendation for a secret match
  - the projection (answers win, recommendations fill, the rest are unresolved)
  - Apply never overwrites a choice
  - pruning
  - the manifest appears only on settled `session-files`/`commit` rows
- **Visual change: yes.** It needs a manual check of the drawer on a fixture tree. That is not possible from this
  session under the envelope (no live-server restart), and the repo has no operator-verification queue.

### Chunk 03 — docs, CHANGELOG, cumulative review

`Type: cumulative-final`. The chunk covers:

- `CHANGELOG.md` (`### Fixed`)
- `FEATURES.md` (`session-files` and the test inventory)
- `SECURITY.md` (a wrap never commits a SQLite database)
- the wrap route row in `docs/configuration-reference.md` (the new outputs)
- `.prawduct/change-log.md`

After that come `/prawduct:critic cumulative` and a **draft** PR (no merge, no auto-merge).
