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

## Blocking issues

**RESOLVED 2026-08-20.** `.prawduct/backlog.md` was un-ignored and committed to `main`
at `643c029` (PR #1031), together with the three migration audit files. The
pre-migration backup the runbook requires genuinely exists, so the
`--archive-scope open` decision stands on real ground. The negation was scoped to
those files only — `.prawduct/artifacts/` was **not** un-ignored wholesale, because it
holds ~54 internal design docs (~1.3 MB, incl. `security-model.md`) in a public repo.

### Open — needs an owner decision

**The cutover switch is machine-local.** `.prawduct/project-state.yaml` is **not**
git-tracked (it falls under the same `.prawduct/*` ignore), so
`backlog_service_repo: Jason-Vaughan/TangleClaw` exists only in this working tree. On a
fresh clone — or on elkaholic, where the operator usually works — the scalar reads unset,
the backlog skill routes to the **markdown backend**, and it reads the frozen file as
live state. The banner warns a human; nothing warns the tooling.

Options (same scoping caution as before — do not add a broad negation):
1. Negate `!.prawduct/project-state.yaml` and commit it. It is ~33 KB of internal project
   state going into a public repo, so it wants the same review pass `backlog.md` got.
2. Extract just the backend fact into a small tracked file.
3. Accept it as per-machine setup and document the one-line fix in the README/onboarding.

## Execution record — 2026-08-20

| Step | Result |
|---|---|
| `restructure apply` | **n/a** — no such op exists; the plan applies at create via `--restructure`. |
| `provision` | 7 labels created (`stage:*` &times;5, `status:submitted`, `status:in-progress`); all 12 pre-existing foreign labels untouched. |
| `import --archive-scope open` | **41 created, 0 skipped, 0 rejected, 0 collisions**, 41 restructured by plan. Issues **#1032–#1072**, contiguous. No unreconciled-status warning. Pacing: ≥709 REST points, never throttled. |
| `verify-migration --archive-scope open` | **exit 0** — `source_items: 41`, `aliased: 41`, and `missing` / `unaliasable` / `collisions` / `status_mismatch` / `duplicate_alias` all empty. |
| Cutover | `backlog_service_repo` set (verified through the plugin's own parser: `post_cutover = True`); frozen-history banner written to `.prawduct/backlog.md`. |
| Merges | `TST-5N8W` #1068 → #1067 · `UPD-7B4X` #1060 → #1059. Both losers CLOSED carrying `superseded_by`; both survivors OPEN with the upleveled titles. |
| Links | `MED-8H5W` #1043 parent of #1040/#1041/#1042 (native sub-issues) · `PRW-6T2M` #1064 related #1065 · `TL-3D5K` #1038 related `NRM-5K8T` #1070, with the scope-fold decision recorded as a comment on both. |
| Cache | `sync` wrote 41 rows with the FTS index built, so post-cutover readers (`find`, `dead-why`, `stalled-transition`, janitor Backlog Health) resolve. |

Fidelity spot-check on `PRW-9K4C` (#1045): parked decision text and both re-open
conditions preserved verbatim; `original_title` stashed in the block; full facet label
set present including the `id:PRW-9K4C` alias.

**Do not re-run `import` or `verify-migration` from here.** The import reconciles every
item to its *markdown* status and would reopen both merged losers; the gate now reads
those two disposals as `status_mismatch` and exits 4 on a migration that is correct.

## Status

- [x] Precondition — backlog service present (3.4.0)
- [x] Step 0 — target confirmed + recorded; label taxonomy provisioned
- [x] Step 1 — pre-migration backup exists (`643c029`)
- [x] Step 1b — id validation (76 records, 0 collisions, 0 unaliasable)
- [x] Step 2/3 — candidates surfaced, dispositions owner-verified
- [x] Step 3b — restructure plan authored, preview rendered, owner-approved
- [x] Step 3c — archive scope chosen (`open`)
- [x] Step 4 — import (41 created)
- [x] Step 5 — spot-check
- [x] Step 6 — gate exit 0 → `backlog_service_repo` set → frozen-history banner
- [x] Step 7 — merges + links applied on the tracker
- [ ] **Commit the banner** (`.prawduct/backlog.md` is modified and uncommitted)
- [ ] **Owner decision** — the machine-local cutover switch (see above)
