# Migration scrub decisions — markdown backlog → GitHub Issues (MG4)

The owner-confirmed record for TangleClaw's one-time backlog migration. Recorded
because the migration is one-time and partly irreversible: a choice remembered
only in a transcript is a choice nobody can audit later.

## Run identity

| Fact | Value |
|---|---|
| Date opened | 2026-08-20 |
| Plugin build that ran the scrub | **prawduct 3.4.0** (`/Users/jasonvaughan/.claude/plugins/cache/prawduct/prawduct/3.4.0/bin/prawduct-hook`) |
| `--plugin-dir` override | **none** — session loaded the released plugin |
| `gh` identity | `Jason-Vaughan` |
| Precondition | `prawduct-hook backlog` prints the usage banner (service present, not an `unknown op` build) |

## Step 0 — target repo (owner-confirmed)

**Target: `Jason-Vaughan/TangleClaw`** — the same repo as the release trains, not a
dedicated backlog repo.

The owner accepted the **interleaving cost** with eyes open: the target already
held ~494 issues (155 open) before the migration, so migrated backlog items land
beside an active hand-filed tracker. Daily triage is handled with a **`stage:*`
label filter** rather than by repo separation. Consequence to remember at
spot-check time: `counts` will report a large `untriaged` figure (every
pre-existing, non-prawduct issue), so the "total = source items" arithmetic does
not read plainly here — **`verify-migration` is the completeness gate, not the
count.**

Recording the target here is **not** the cutover. `backlog_service_repo` stays
unset until the import is verified.

## Step 3c — archive scope (owner-confirmed)

**Scope: `open`.** Import only the live set; do not mint a closed issue per
historical item.

- Migrated: **41 items** (40 `## Open` + 1 `## Promoted`).
- Skipped: **35 archived items**, which remain in the source markdown.
- Accepted cost: the skipped set is **outside the migrated tracker** — after
  cutover the backlog skill treats the source file as frozen history and stops
  reading it, so no adapter op at any flag reaches those items. They are not in
  the MG2 export either (the export dumps the migrated repo).
- Backfilling later under `--archive-scope all` is possible and mints no
  duplicates, but is **not** a free top-up: the skip path still reconciles
  status, so it would re-drive every migrated item to its markdown status and
  reopen anything closed on the service since cutover.

> ⚠ **Open risk against this choice — see "Blocking issues" below.** The scope was
> chosen on the premise that the skipped archive survives "in the git-tracked
> markdown." In this repo `.prawduct/backlog.md` is **not** git-tracked.

## Step 3 — dispositions (owner-verified)

| id | action | reason |
|---|---|---|
| `TST-5N8W` → `TST-3M6R` | **merge** (altitude) | `TST-5N8W`'s own body says "same defect class as TST-3M6R"; one change converts both suites to `node:assert/strict`. Survivor retitled to the defect class. |
| `UPD-7B4X` → `UPD-3F7Q` | **merge** (altitude) | Same `_getReleasesUrlBase` origin-lookup site from #716 — the test seam and the back-off land in one edit. Survivor retitled to the shared root cause. |
| `UPD-5K9V` | keep separate | Different axis (version-comparison honesty), not the origin-lookup root. |
| `PRW-6T2M` + `PRW-4J8D` | keep, link `related` | Shared root cause (prawduct tooling anchors to the primary checkout) but two code sites in an upstream repo — fails the "single change" test. |
| `MED-8H5W` ⊃ `MED-4T7K`/`MED-6P2N`/`MED-9X3B` | keep, link parent/child | Four deliverables of one epic, not duplicates. |
| `PRW-5N8T` | **archive at source, do NOT migrate** | Fact-checked: upstream `brookstalley/prawduct#128` closed 2026-08-02 and the fix landed for TC — `.prawduct/.test-evidence.json` records passed 6499 against a real 6532-test suite, i.e. no ~2x undercount. The item's own criterion ("keep open until the upstream fix ships in a plugin release TC picks up, then archive") is met. Saves one permanent issue number. |
| `PRW-9K4C` | **keep**, migrate as-is at `stage:research` | Operator parked it 2026-07-17 with an explicit "do not pick for implementation". Body migrates verbatim, so the parked decision and its two re-open conditions survive. |
| `ENG-8V3N` | **keep** | Genuine new feature work; the #990 review that created it shipped this week. |
| `DEP-8H7W` | **keep** — not moot | Verified live on Node 22.22.3: `ExperimentalWarning: SQLite is an experimental feature` still fires. |

**No stale set.** The 90-day rule fires on nothing — the oldest item is
2026-07-09 (42 days at scrub time).

### Applied at source (before the import)

`PRW-5N8T` was moved to `## Archive` with `status: shipped · closed-by:
prawduct-3.4.0 · reviewed: 2026-08-20`, body preserved verbatim plus an archive
rationale paragraph. This is the **only** disposition applied to the source: it
is the sole mechanism by which "do not migrate" can be honored, because
`--archive-scope open` skips archived records at build time. Every other
disposition (the two merges, the links) runs **on the tracker after the gate
passes**, per the runbook.

Accepted side-effect: `PRW-9K4C`, `PRW-6T2M` and `PRW-4J8D` each carry
`related: PRW-5N8T`, which will **dangle** post-cutover — the id resolves to no
issue, because it was deliberately never minted.

## Step 3b — restructure plan

Titles-only restructure (plus a full `kind:` backfill). Plan:
`.prawduct/artifacts/migration-restructure-plan.json`; preview:
`.prawduct/artifacts/migration-restructure-preview.md`.

- 41 plan entries over 41 source items — **27 titles rewritten**, **41 `kind:`
  assigned**, **0 bodies restructured**.
- **0 titles fail issue-standard §1**, so the import's pre-flight will not refuse.
- 6 items flagged `non_atomic` for owner manual split, never auto-split:
  `TL-3D5K`, `MED-8H5W`, `SR-8V4T`, `AUTH-4B7K`, `PRM-7T3Q`, `PRW-4J8D`.
- 201 WARN-only lint findings remain (175 `missing-section`, 15 `body-too-long`,
  11 `bug-missing-env`) — bodies migrate verbatim and do not follow the §2
  section template. Advisory only; they never block a write.

Two survivor titles are **upleveled in the plan rather than after the merge**
(`TST-3M6R`, `UPD-3F7Q`), so each survivor is created already carrying the
root-cause title and needs no post-merge retitle write.

## Blocking issues (unresolved at the time of writing)

**`.prawduct/backlog.md` is NOT git-tracked.** `.gitignore:10` ignores
`.prawduct/*` fail-closed and negates only `.prawduct/change-log.md`;
`git ls-files` does not know the file, and edits to it produce no `git status`
entry. This falsifies the runbook's Step 1 premise ("the source is git-tracked —
that is the pre-migration backup") and removes the safety net the `open` scope
decision rests on: under `open`, the 35 skipped archived items would live in
exactly one place — this machine's working tree — with no git history, no
survival across a fresh clone, and no presence in the MG2 export.

The repo's own `.gitignore` already documents this exact failure mode for a
different path: "Ignoring plans made every clone of this repo planless."

Resolve before importing. Options, in the order recommended:
1. Negate the ignore (`!.prawduct/backlog.md`) and commit the file — restores the
   runbook premise and matches the existing precedent for `change-log.md`.
2. Switch to `--archive-scope all` so history lands in the tracker (costs 23 more
   title rewrites and 35 more issues, and re-preview).
3. Accept the risk explicitly and record it here.

**Secondary:** this decisions file, the plan and the preview also sit under the
ignored `.prawduct/artifacts/`, so they are untracked too — weak auditability for
a record whose whole purpose is to be auditable later.

## Status

- [x] Precondition — backlog service present (3.4.0)
- [x] Step 0 — target confirmed + recorded
- [x] Step 1b — id validation (76 records, 0 collisions, 0 unaliasable)
- [x] Step 2/3 — candidates surfaced, dispositions owner-verified
- [x] Step 3b — restructure plan authored, preview rendered, 0 blocking titles
- [x] Step 3c — archive scope chosen
- [ ] **Owner approves the preview in aggregate**
- [ ] Resolve the git-tracking blocker above
- [ ] Step 0 — `provision` label taxonomy against the target
- [ ] Step 4 — import
- [ ] Step 5 — spot-check
- [ ] Step 6 — `verify-migration` (exit 0) → set `backlog_service_repo` → frozen-history banner
- [ ] Step 7 — apply the confirmed merges + links on the tracker
