# ADR 0007: Project Map Freshness — Section-Scoped, Curation-Preserving, Idempotent Refresh

**Status:** Accepted (2026-06-30, PIDX slice 3 / #360, #356).
**Source issues:** #360 (self-regulating "where things live" file map), #356 (shared-dir / doc-group membership).
**Builds on:** ADR 0002 (Wrap Pipeline Contract — `project-map` is a new step honoring the never-blocks, stage-then-flush step-kind philosophy). The slice-1 prime pointer (`reference, not inline`) and the additive-not-unified-with-FEATURES.md decision are recorded in the spec `.prawduct/artifacts/pidx-project-map.md`, not here.

---

## Context

PIDX seeds `PROJECT-MAP.md` on toggle-on (slice 1) and snapshots shared-doc group membership into it (slice 2). Both are **point-in-time** writes. Over a project's life the top-level directory layout drifts (dirs added/removed) and group membership changes, so a map that's only ever seeded goes stale — the exact failure the map exists to prevent. Slice 3 keeps it fresh on every wrap.

The hard constraint: the file is **co-owned**. The directory skeleton and the shared-dir snapshot are machine-maintained, but the per-directory *descriptions* are curated by hand (that's the whole value — "what each area is for"), and an operator may add their own sections. A refresh that regenerates the file wholesale (the obvious implementation, reusing slice 1's `_buildProjectMapContent`) would erase every curated description and every operator section on the first wrap. That makes the feature actively hostile to the curation it's supposed to accumulate.

## Decision

The `project-map` wrap step refreshes **only the bodies of the two machine-owned sections** — `## Structure` and `## Shared directories / doc groups` — via a section-scoped splice (`lib/projects.js:_refreshProjectMapContent`). Three properties define it:

1. **Curation-preserving.** The Structure refresh keys on the directory bullet (`` - `dir/` — … ``): a surviving directory's bullet line is carried across **verbatim** (description intact), a new directory gets a `<!-- describe -->` stub, a vanished directory's bullet is dropped. Everything outside the two managed sections — the header comment, operator-added sections — is preserved byte-for-byte. Free-form prose *inside* the Structure section is not preserved: a description belongs on the dir bullet (the seed format), longer notes belong in an operator-owned section (which the splice never touches).

2. **Idempotent → equality is the drift signal.** Refreshing already-fresh content returns it byte-for-byte identical. So the step's drift check is a plain `newContent === existing` string compare: equal ⇒ `skipped` (no write, mtime stable); differ ⇒ stage the new content. No separate "has anything changed" bookkeeping, no diff heuristic that can disagree with what actually gets written.

3. **World-sourced, not diff-sourced (unlike `features-toc`).** `features-toc` keys off the branch diff because it indexes *files touched this session*. Structural freshness is not a branch notion — a directory added directly on disk should surface even if no tracked file in it changed — so this step reads the live filesystem (`_listTopLevelDirs`) and the live store (`_collectProjectGroups`), and needs no git / base-branch resolution.

The step stages `{primingPath, newContent, changed:true, mapRefresh:true, addedDirs, removedDirs}`; `lib/wrap-steps/commit.js:_flushStagedWrites` duck-types the `{primingPath, newContent, changed}` trio and writes the file inside the commit step's single-transaction flush (never in the step itself), and `_buildBodyLines` emits a `- Project Map: refreshed (+A/-R dir(s))` audit line.

## Alternatives considered

- **Full regenerate from `_buildProjectMapContent`.** Simplest code; rejected — erases curated descriptions and operator sections (see Context). The curation requirement is non-negotiable.
- **A structured front-matter / marker block the machine owns, descriptions stored separately.** Survives wholesale regenerate, but turns a human-readable markdown file into a format with hidden machine state — worse for the "agent reads it first, human curates it" use. Rejected as over-engineered for a markdown index.
- **A dedicated lazy-require break vs. moving the pure helpers out of `projects.js`.** `lib/wrap-steps/project-map.js` requires `../projects`, closing the `projects → sessions → wrap-pipeline → wrap-steps/project-map` cycle and capturing `projects.js`'s partial exports at module-init. Chosen fix: lazy-`require('../projects')` inside `run()` (resolved fully by wrap time). Moving the helpers to a new module was the alternative; rejected to keep all PROJECT-MAP builders co-located in `projects.js` (slices 1–3 cohesion) — the one-line lazy require is the smaller, local change.

## Consequences

- The map stays current without ever clobbering curation — descriptions accumulate across sessions as intended.
- A wrap with no structural/membership change is silent and write-free (idempotence), so `PROJECT-MAP.md` only churns git history when it genuinely changed.
- The "only dir bullets survive inside `## Structure`" rule is a real constraint operators must learn (notes go in their own section). It's documented in the seed header comment and the spec; the alternative (preserving arbitrary in-section prose) would make the merge unpredictable.
- Deferred (unchanged from slices 1–2): unifying FEATURES.md + PROJECT-MAP.md, and two-levels-deep auto-skeleton descriptions.

## Amendment (2026-06-30, #423): self-heal when the index is missing

Originally the wrap step **skipped** a missing `PROJECT-MAP.md` (mirroring `features-toc`'s "deletion = opt-out" read). That's incoherent for this feature: **the toggle is the off-switch, not file deletion.** A toggle that's on but a file that's missing is an anomaly — a fresh clone where the file wasn't committed, a delete-to-regenerate, or a toggle enabled through a path that didn't seed — and "skip forever" means the index the operator asked for never materializes (acute when enabling Project Map across many/large projects).

So the step now **self-heals**: toggle on + file missing → **create** it from the current skeleton + membership (`_buildProjectMapContent`), staged through the same commit flush, commit body `- Project Map: created (N dir(s))`. To opt out, toggle off; to regenerate, delete and let the next wrap recreate.

**Compute invariant (load-bearing).** Both the create and the refresh paths enumerate **top-level directories only** — a single `fs.readdirSync` of the repo root, no recursion, no file reads. Cost scales with the *number of top-level folders* (dozens), never the size of the tree, so it stays millisecond-scale even on a 300k-line repo (e.g. TiltV2). **Any future change that descends 2+ levels (the deferred deeper-skeleton idea) would break this invariant and must be opt-in / bounded.**
