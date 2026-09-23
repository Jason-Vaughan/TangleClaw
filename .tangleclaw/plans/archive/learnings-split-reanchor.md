---
title: "Split the migrated learnings by concern (#1819) and refresh the Prawduct anchor (#1820)"
status: COMPLETE 2026-09-23 — Chunk 01 done locally (#1819, comment posted; closes with this PR); Chunk 02 ships in this PR (#1820); D5 curation filed as #1822
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-23 (message 25514565)
issues: [1819, 1820]
scope: learnings-split-reanchor
branch: chore/learnings-split-reanchor
partition: serial. Two small, independent pieces; neither is worth a delegate.
critic_mode: none owed by the gates (no judgeable code); one independent Critic pass over the CLAUDE.md diff before the PR
---

# Split the migrated learnings (#1819) and refresh the Prawduct anchor (#1820)

## Privacy boundary (read first)

The learnings corpus is **local-only and gitignored** (#1792, Architect ruling 2026-09-22). Nothing
in this plan, the PR, the CHANGELOG or any issue comment may quote a rule. This plan names rules only
by their **position** in the pre-split `active-rules.md` (1–133, in file order) and the area files
by name. The byte-verified backup of the pre-migration corpus is in this clone's
`.git/prawduct/learnings-backup/20260923T165726Z/`. Before editing, the split takes its own backup of
`active-rules.md` in the same place.

## Confidence check

1. **Problem.** Reading any code file loads `active-rules.md` in full: 115 KB, about 30k tokens. The
   file is 7× prawduct's 16 KB per-file budget, and a gitignored `learnings_budgets` override holds
   it at 116 KB.
2. **Success.** Every learnings file is ≤ 16 KB with **no** budget override. Each rule is in
   exactly one area file whose `paths:` covers where it fires. `prawduct-hook learnings-files` lists
   the new set. A lossless check shows every sentence of the original is still present. CLAUDE.md
   carries prawduct's current anchor, and `prawduct-hook reanchor` reports it healthy.
3. **Out of scope.** No rule is rewritten, shortened or deleted to fit. `core.md` is unchanged.
   Rules that look stale (D5) get a follow-up issue, not an edit here. The TangleClaw
   startup-rules channel is untouched.

## What the survey found (drives D1)

About 85% of the 133 rules are **cross-cutting engineering discipline**: whether tests bite,
fixture realism, guard failure direction, sweeping siblings, claim verification and shell hazards.
Only about 15% belong to one subsystem (wrap, store, UI, platform). Splitting strictly by subsystem,
as the issue suggests, leaves roughly 90 KB in a "general" file. So the split is **by concern**, and
each file is scoped to the paths where that concern fires.

## Chunk 01 — the split (#1819): local-only, no tracked diff

| Area file | Rules (pre-split position) | Size | `paths:` |
|---|---|---|---|
| `testing-mutation.md` | 1, 8, 12, 22, 38, 43, 44, 45, 59, 73, 74, 94, 114, 121, 124 | ≈15 KB | `test/**` |
| `testing-fixtures.md` | 4, 10, 24, 26, 33, 36, 37, 42, 47, 50, 66, 80, 88, 89, 101, 102, 104, 107, 132 | ≈14.5 KB | `test/**` |
| `guard-failure-modes.md` | 7, 15, 18, 20, 29, 31, 32, 82, 96 | ≈12.5 KB | code paths (below) |
| `change-sweeps.md` | 6, 16, 17, 23, 25, 27, 46, 52, 85, 86, 116, 125, 128, 129 | ≈13.7 KB | code paths |
| `shell-git.md` | 5, 11, 14, 28, 30, 54, 58, 62, 75, 90, 92, 117, 118, 127, 130, 131, 133 | ≈12.2 KB | **none: always loaded** (D2 as modified) |
| `claims-review.md` | 3, 13, 21, 39, 40, 41, 53, 57, 77, 81, 83, 84, 87, 91, 98, 113, 115, 122, 123 | ≈14.9 KB | code paths **and** doc surfaces (D6 as modified) |
| `platform.md` | 48, 49, 60, 64, 65, 70, 71, 72, 76, 78, 105, 106, 110, 126 | ≈10.6 KB | `deploy/**`, `scripts/**`, `server.js`, `lib/caddy*.js`, `lib/tmux.js`, `lib/tunnel*.js`, `lib/dir-scanner*.js`, `lib/launch*.js`, `lib/medusa*.js`, `lib/port-scanner.js` |
| `ui.md` | 34, 35, 55, 56, 63, 97, 99, 111 | ≈7.4 KB | `public/**` |
| `evidence.md` | 51, 79, 108 | ≈1.7 KB | code paths **and** doc surfaces (D6 as modified) |
| `governance.md` | 19, 61, 68, 69, 93, 95, 100, 103 | ≈3.9 KB | doc surfaces |
| `store.md` | 2, 9, 112 | ≈3.4 KB | `lib/store.js`, `lib/draft-store.js`, `test/store*.test.js` |
| `wrap.md` | 67, 109, 119, 120 | ≈2.3 KB | `lib/wrap*.js`, `lib/wrap-steps/**`, `lib/stranded-wraps.js` |

"Code paths" means today's set: `lib/**`, `server.js`, `public/**`, `bin/**`, `scripts/**`,
`hooks/**`, `deploy/**`, plus `test/**`. "Doc surfaces" means `CHANGELOG.md`, `FEATURES.md`,
`README.md`, `CLAUDE.md`, `docs/**`, `.tangleclaw/plans/**` and `.prawduct/**`.

Sizes are before the duplicate merges in D4, which only shrink them. The roster is a starting
assignment: moving a rule between files at build time is an implementation call, provided every file
stays ≤ 16 KB.

**Load effect** (after the D2/D6 rulings), stated honestly. Every session now loads `shell-git.md` (≈12.6 KB) beside `core.md`. A lib+test session loads about 84 KB instead of 115 KB. A `public/` UI session loads about 64 KB. A doc-only session loads about 33 KB and no testing rules. No single file is over budget, so the gate stops needing an override.

**Steps**
1. Back up `active-rules.md` beside the existing backup. Generate the area files with a script
   driven by the table above. Bodies stay verbatim. Each file gets a one-line `# <Area>` heading and
   its `paths:` frontmatter.
2. Apply the D4 merges by hand.
3. Run the lossless check: every sentence of the original appears in exactly one output file, and
   the only exceptions are the merged leads listed in D4.
4. Delete `active-rules.md`. Remove the `learnings_budgets` entry from `.prawduct/project-state.yaml`.
5. Verify: `prawduct-hook learnings-files --json` lists `core.md` plus the twelve area files. Every file
   is ≤ 16 KB (`wc -c`). The budget gate is quiet (`prawduct-hook stop` dry path, or the next
   session-end).
6. Comment on #1819 with the file names, sizes and path scopes only, no rule text, and close it.

## Chunk 02 — the anchor (#1820): the tracked PR

1. In this worktree, run `prawduct-hook reanchor` (dry run) and confirm the replacement touches only
   the `PRAWDUCT:ANCHOR` block. Then run `prawduct-hook reanchor --apply`.
2. Add a `### Internal` CHANGELOG entry. Commit this plan with it.
3. Run one Critic pass, then open the PR (`Fixes #1820`, `Refs #1819`) and arm auto-merge
   (`--squash`, per project-preferences) once the Architect has ruled.

## Architectural decisions (for the Architect)

- **D1. Split by concern, not by subsystem.** *Recommend:* the eleven concern files above, each
  path-scoped. *Rejected:* a subsystem-only split (wrap/launch/medusa/UI), which leaves about 90 KB
  in one general file and does not fix the problem. *Rejected:* keeping one file with a lowered
  override.
- **D2. Where action-triggered rules go** (shell and git hazards, which fire on a command rather
  than on a file read). *Recommend:* `shell-git.md` keeps today's broad code-path scope, so it still
  loads in every code session as it does now. *Rejected:* promoting them to `core.md`, which would
  take it to about 22 KB, over budget. *Rejected:* a narrow scope, which would silently stop them
  firing.
- **D3. Budget.** *Recommend:* every file ≤ 16 KB, and **delete** the `learnings_budgets` override.
  *Rejected:* keeping a reduced override as headroom, because an override is the thing that let the
  file reach 115 KB.
- **D4. Duplicates.** *Recommend:* merge losslessly, meaning one lead sentence with every instance
  and corollary kept, and only for these clear pairs: 5+11 (pipeline exit codes), 28+58
  (`check-ignore` scope), 45+73+74 (a finding-fix needs its own falsifying guard) and 94+121 (name
  the mutation, then watch it go red). Rule 1 stays separate: it is about the mechanism, not the
  guard. *Rejected:* condensing or rewording, which the issue forbids.
- **D5. Stale rules.** Several governance rules cite prawduct commands that 3.6.0 lists as inert
  (`regen-views`, `stamp-merged`), and one is marked SUPERSEDED. *Recommend:* carry them verbatim
  into `governance.md`, and file a follow-up `[chore]` issue for a curation pass that names them by
  position only. *Rejected:* editing or dropping them in this chunk, which would trim rules to fit.
- **D6. Doc-surface scoping changes when two concerns reach a session.** `claims-review.md` and
  `governance.md` load on a read of a doc surface, not of code. A code-only session therefore no
  longer gets them until it opens the CHANGELOG, a plan or `.prawduct/`, which nearly every chunk
  does before a PR. *Recommend:* doc-surface scope. *Rejected:* also scoping them to code, which
  puts about 20 KB back into every code session.
- **D7. #1820 applied verbatim, standalone.** The dispatch pulls #1820 forward, replacing its
  "ride the next PR" deferral. *Recommend:* apply prawduct's replacement anchor byte-for-byte, with
  no local edits; it changes agent-facing governance prose. *Rejected:* a hand-edited anchor, which
  `reanchor` would flag as drift again.

## Architect rulings (2026-09-23, message 0ab96d5e)

- **D1 APPROVE.** Split by concern. The roster may change under D2 and D6.
- **D2 MODIFY.** Shell and git hazards are triggered by a command, so they must be active from session start. `shell-git.md` has no `paths:` and loads every session. prawduct's loader supports this: `learnings_files.parse_frontmatter` reads a file with no `paths:` as loaded unconditionally, and the budget stays per file. No re-escalation was needed.
- **D3 APPROVE.** The override is deleted. Every file checks at ≤ 16 KB; the largest is 15,710 bytes.
- **D4 APPROVE.** Only the four lossless merges. Every rule is preserved, and a check confirmed each appears exactly once.
- **D5 APPROVE.** The stale rules are carried verbatim. The follow-up issue names them by position only, with no quotations.
- **D6 MODIFY.** Split by what triggers a rule. Claim-verification and review rules (`claims-review.md`) and evidence rules (new `evidence.md`: 51, 79, 108) are scoped to code+test paths **and** doc surfaces. `governance.md` keeps only doc-triggered bookkeeping.
- **D7 APPROVE.** The anchor is applied byte-for-byte. Only the anchor block changed, and `prawduct-hook reanchor` reports `ok`.
- "Architecture approval does not certify implementation or merge readiness": the Critic and CI gate the PR.

Verified after regeneration: twelve area files, all rules present exactly once, the budget check quiet, and no glob that matches no tracked file. A live read of `lib/port-scanner.js` loaded `platform.md` and `evidence.md`. The always-loaded `shell-git.md` can only be confirmed at the next session launch, which is owed.

## Status

- [x] Chunk 01 — split (#1819), local-only, regenerated under the rulings. D4 merges applied; the undo is the backup in `.git/prawduct/learnings-backup/20260923-split-1819/`. #1819 has its comment (sizes and scopes only), and the D5 follow-up is #1822.
- [x] Chunk 02 — reanchor PR (#1820). The cumulative Critic found 0 blocking. Owed next session: confirm that the always-loaded `shell-git.md` is in context at launch.
