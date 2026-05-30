# ADR 0001: Symmetric Capability Gates

**Status:** Accepted (2026-05-11), extended (2026-05-14 with #155 — generalized template-array reconciliation), extended (2026-05-30 with #275 — framework-owned subtree sync for value-updates/reorders/renames)
**Source issue:** #145 chunk 3 (audit closeout)
**Related issues:** #103, #119, #136, #137, #140, #145, #151, #155, #158, #139, #264, #266, #275
**Related ADRs:** ADR 0002 — Wrap Pipeline Contract (the `wrapShapeFromTemplate` shim it mandates is an instance of this ADR's "one read predicate per conceptual state" rule)
**Source feedback:** `feedback_symmetric_capability_gates.md` (Critic-surfaced on #103 PR #125)

---

## Context

TangleClaw has multiple subsystems that encode the same conceptual state in two locations at once. The most consequential examples:

| Conceptual state | Persisted in | Materialized in | Re-derivation function |
|---|---|---|---|
| Methodology | `projects.methodology` (SQLite) + `.tangleclaw/project.json.methodology` | `.claude/settings.json.hooks` (methodology entries) | `engines.syncEngineHooks` |
| Engine | `projConfig.engine` | `.claude/settings.json` is consulted by the runtime when `engine === 'claude'`; otherwise it's stale | `engines.syncEngineHooks` (cleanup branch) |
| silentPrime | `projConfig.silentPrime` | `.claude/settings.json.hooks.SessionStart` (baseline entry) + `.tangleclaw/session-prime.md` | `engines.syncEngineHooks` (via `_buildBaselineHooks`) + `sessions._removePrimeFile` |
| Methodology hook `requires` | hook entry's `requires` array in `data/templates/<id>/template.json` | runtime file at `<projectPath>/<requires-path>` (the script the hook would invoke) | `engines._filterHookEntriesByRequires` (skips entry if any required path absent) |

When two locations encode the same conceptual state, **every transition path between configurations must consistently update both locations**. Asymmetric transitions — where one path updates state-A but skips state-B, or updates state-B with the wrong derivation — leak orphan state: stale entries in one location that no longer reflect the other.

We have hit this class of bug repeatedly over the past two months. Each incident followed the same shape: a PATCH branch in `lib/projects.js:updateProject` mutated half the paired state and deferred the other half "to next session launch" or "to next sync." On the asymmetric path, the orphan state hung around — sometimes dormant, sometimes load-bearing for the next bug.

### Incident catalog (the rule learned the hard way)

- **#119, #136** — Bundled methodology runtime templates drift from on-disk runtime template state. TC ships templates from `data/templates/<id>/`; users' installs cache them in `~/.tangleclaw/templates/`. A template change in TC's release didn't propagate to existing users' cached copies because no sync function reconciled the two locations on launch. The cache-vs-bundle pair was a symmetric-gates case nobody had named yet.
- **#137** — `PATCH /api/projects/:name` with `silentPrime: true` wrote the flag to `projConfig` but didn't re-sync `.claude/settings.json`. The toggle looked enabled, wasn't enabled until next launch. Fixed by adding the `syncEngineHooks` call to the silentPrime PATCH branch.
- **#140** — Discovered during Critic review of #137. Engine PATCH (claude → gemini) regenerated the engine config file but didn't re-sync hooks, so a stale `SessionStart` entry sat in `.claude/settings.json`. Dormant because non-claude engines don't read the file — but a real orphan, and a real symmetry violation. Fixed by making the non-claude branch of `syncEngineHooks` write-active (read existing settings, `delete settings.hooks`, preserve non-hook keys, write back).
- **#145 chunk 1** — Methodology hooks declared in bundled templates were injected without verifying their runtime scripts existed. Created the prawduct orphan-Stop-hook → infinite synthetic-user-message loop. The paired state here was hook-reference-in-settings-json ↔ runtime-script-on-disk. Fixed by adding the `requires` field to hook entries and gating injection on path presence.
- **#145 chunk 2** — The cleanup half of #145. Chunk 1 fixed the creation gate; existing affected projects needed a one-pass strip without waiting for the next session launch. Dashboard banner + `POST /api/projects/repair-orphan-hooks` filled the gap. Also reinforced that the strip path must preserve non-orphan hooks and non-hook keys symmetrically — same logical contract `syncEngineHooks` honors on the methodology-flip path.
- **#145 chunk 3** — The audit (this ADR). Verified the methodology-flip path's cleanup behavior. Found a latent ReferenceError on the `PATCH methodology: null` removal branch (`currentTemplate` declared inside an inner block, referenced outside) that had never been exercised by tests. Hoist-fix shipped; the deeper SQL-constraint blocker that surfaced after the hoist-fix filed as #151.
- **#151** — Retired the `methodology: null` semantic entirely rather than fixing the (unreachable) removal path. Per `docs/methodology-guide.md` *"Each project gets one methodology"* — `minimal` is the canonical no-workflow option. The API now rejects null with a 400 pointing the caller at `'minimal'`. The dead removal branch in `updateProject` (~40 lines) was deleted; `DEFAULT_PROJECT_CONFIG.methodology` was changed from `null` to `'minimal'` to align projConfig with the DB schema's `NOT NULL DEFAULT 'minimal'`. The three sources of truth (DB schema, projConfig default, API contract) now agree.
- **#158** — Chunk-1's `requires` filter (the runtime-precondition gate) is load-bearing for the orphan-hook-loop protection, but only effective when the runtime methodology template has the `requires` field on each hook entry. `_mergeBundledTemplate` (#136 / PR #156) reconciled `wrap.steps` and missing top-level *object* fields but did NOT traverse `hooks.<engine>[].entries[]` to backfill `requires`. Pre-#146 runtime templates therefore stayed `requires`-less even after v3.16.0's reconciler shipped, and chunk-1's filter passed those entries through as a no-op — every prawduct project on a pre-#146 install kept hitting the loop. Closed by `_mergeBundledHookEntries` in `lib/store.js`, which walks hook entries inside the reconciler and backfills missing keys additively, matched by `matcher` string with index fallback. Confirmed live on TC-v3 itself on 2026-05-12 against server already running v3.16.0.

The recurrence is the lesson. The pattern is real, named, and worth enforcing.

---

## Decision

**All PATCH-time transition paths that mutate one half of a paired state MUST also update the other half in the same call.** No "lazy" deferral to the next launch / next sync. The syncer must be called inline.

Concretely — the four gates currently in scope:

| Gate | DB / projConfig field | On-disk artifact | PATCH branch must call |
|---|---|---|---|
| **Methodology** | `projConfig.methodology` + `projects.methodology` | `.claude/settings.json.hooks` (methodology entries) | `engines.syncEngineHooks(projPath, newTemplate)` |
| **Engine** | `projConfig.engine` | `.claude/settings.json` (entire file's relevance) | `engines.syncEngineHooks(projPath, methodologyTemplate)` (cleanup branch handles non-claude case) |
| **silentPrime** | `projConfig.silentPrime` | `.claude/settings.json.hooks.SessionStart` (baseline entry) + `.tangleclaw/session-prime.md` | `engines.syncEngineHooks(projPath, methodologyTemplate)` + `sessions._removePrimeFile(projPath)` on OFF transition |
| **Methodology hook `requires`** | hook entry's `requires` array | `<projectPath>/<requires-path>` (runtime file) | `engines._filterHookEntriesByRequires(hooks, projPath)` inside the `syncEngineHooks` pipeline |

Verified callsites that already follow the rule (line numbers as of #145 chunk 3 merge):

- `lib/projects.js:createProject` → calls `syncEngineHooks` after writing engine config (line 238)
- `lib/projects.js:attachProject` → calls `syncEngineHooks` after detecting methodology (line 1020)
- `lib/projects.js:updateProject` engine branch → calls `syncEngineHooks` after writing engine config (line 1149)
- `lib/projects.js:updateProject` methodology-removal branch → branch at line 1157; calls `syncEngineHooks(projPath, null)` at line 1203
- `lib/projects.js:updateProject` methodology-switch branch → branch at line 1201; calls `syncEngineHooks(projPath, newTemplate)` at line 1269
- `lib/projects.js:updateProject` silentPrime branch → calls `syncEngineHooks` at line 1346 + `sessions._removePrimeFile` at line 1357

The chunk-3 audit confirms all six callsites are in place and symmetric.

---

## Consequences

**Benefits**

- No orphan state across PATCH transitions. The file on disk always reflects the field in the config.
- Caller-side bugs (forgetting to call the syncer) caught at the test boundary, not in production. The regression test for each gate is a single assertion: "after PATCHing field-X, the paired on-disk artifact reflects the new value."
- New flags/fields that affect on-disk state get the same treatment by default. The ADR is the playbook.

**Trade-offs**

- PATCH calls do more work than the minimum necessary state mutation. The methodology PATCH writes both the DB row AND `.claude/settings.json` even if the user only cares about the database value at that moment. Acceptable cost — disk I/O on a single settings file is negligible.
- Cross-module dependencies are unavoidable. `lib/projects.js` requires `lib/engines.js` and `lib/sessions.js` to call their syncers. Verified non-cyclic (see #137 cycle check); future additions should re-verify.
- The rule is enforced socially (Critic review, this ADR) rather than mechanically. A linter rule could theoretically detect "writes to projConfig.X without calling syncX" but the symmetry isn't fully expressible in static analysis. Until that exists, this ADR + the matching test pattern are the enforcement.

---

## How to apply to new gates

When adding a new flag/field that affects on-disk state:

1. **Identify the paired state.** Which file gets re-derived from this flag?
2. **Identify ALL PATCH branches that could change the flag value.** Don't forget the implicit branches — methodology change can cascade into hook change can cascade into prime-file presence.
3. **Each branch must call the syncer with the new state.** Not "schedule a sync." Not "queue it." Inline, in the same call.
4. **Write a regression test that asserts the cleanup direction for every transition pair.** ON → OFF, OFF → ON, A → B, A → null. Test the cross-product, not just the OFF → ON case.
5. **If the paired state has multiple writers** (e.g. both methodology hooks and baseline hooks land in `.claude/settings.json`), make sure the syncer is *idempotent* and *additive only on intent*. The syncer must not preserve the previous methodology's hooks just because they were there; it must rebuild from the new state.

---

## Anti-patterns this ADR forbids

- **"Defer to next launch."** If a PATCH changes state, the on-disk reflection must update in the same call. Deferral creates a window where the two halves disagree.
- **"Silent no-op on the non-relevant branch."** If `engine !== 'claude'`, `syncEngineHooks` used to early-return without touching `.claude/settings.json`. That left orphan hooks from a prior claude state. The branch is now write-active and clears orphans.
- **"Merge into existing instead of rebuild from intent."** If the methodology switches from prawduct to minimal, the new `.claude/settings.json.hooks` must come *only* from minimal's template + baseline. NOT "minimal's hooks + whatever was there before." Rebuild from intent; never carry forward unintended.
- **"Single-direction regression test."** Testing only A → B doesn't prove B → A works. Both directions of every paired transition need coverage.
- **"Split-brain default values."** When a field has two sources of truth (e.g. DB schema default + in-memory config object default), both must agree on the canonical value. Pre-#151, methodology defaulted to `'minimal'` in the DB but `null` in projConfig — every reader had to know which source to trust. Resolve by picking one canonical value at both layers and rejecting the unreachable third state at the API.
- **"Protective sync exists but doesn't traverse the data shape required to deliver the protection."** A reconciler that only covers a subset of the bundled→live state class leaves the gate it was meant to protect un-protected for existing installs. Pre-#158, `_mergeBundledTemplate` reconciled `wrap.steps` + top-level object fields but did not traverse `hooks.<engine>[].entries[]` to backfill `requires`. The chunk-1 protection looked deployed (filter code shipped) but was a no-op everywhere the runtime template predated chunk 1. Resolve by: when adding a sync function intended to protect gate G, write a test that proves the sync actually delivers the protection on the canonical legacy data shape, not just on freshly-generated state.

---

## Generalized template-array reconciliation (#155 extension)

The bundled-template-drift class introduced by #119 and #136 is a single-direction sync: `data/templates/<id>/template.json` (bundled, ships with each release) → `~/.tangleclaw/templates/<id>/template.json` (live runtime cache, written on first launch and reconciled on every server start). It is not a paired-state gate in the strict sense, but the same anti-pattern bit us repeatedly: a hardcoded reconciler covered one path and missed the rest, so each new array path that drifted needed its own targeted incident before being plumbed in. #136 covered `wrap.steps`. #158 covered hook-entry `requires` backfill. Everything else (the audit table in #155) stayed un-reconciled and accumulated drift.

#155 generalizes the reconciler by replacing path-hardcoded logic with a declarative policy table — `lib/store.js:ARRAY_RECONCILERS`. Adding a newly-tracked array path is a one-line registry entry: `{ path, reconcile, label, idKey? }`. The driver inside `_mergeBundledTemplate` dispatches identically across every registered path.

### Policies

| Policy | Used for | Behavior |
|---|---|---|
| `_reconcileOrderedSubset` | `wrap.steps`, `prime.sections` | If `live` is a strict ordered subset of `bundled`, replace with `bundled`. Otherwise leave alone. Original #136 incident shape. |
| `_reconcileSetUnion` | `wrap.captureFields`, `init.directories` | Append bundled entries not present in `live`, preserving live order at the front. String elements only. |
| `_reconcileMergeBy` | `phases`, `evalDimensions.tier1`, `evalDimensions.tier2`, `evalDimensions.tier3`, `actions` | Match by string equality on `entry[idKey]` (`id` for the first four, `label` for `actions`). Append bundled entries whose idKey value is absent from `live`. Never overwrite a matched entry's field values — additive only. Appended entries are deep-cloned to prevent aliasing. |

Hook arrays (`hooks.<engine>.<event>[]`) remain handled separately by `_mergeBundledHookEntries` (#158) because they have match-by-matcher semantics with an index-fallback policy that doesn't fit the plain-array driver.

### Acknowledged limitations

Both `_reconcileOrderedSubset` and `_reconcileMergeBy` cannot distinguish "user is on an older bundled version that never had entry X" from "user intentionally removed entry X." Both shapes produce a `live` whose contents (or id-set, for `mergeBy`) are a subset of `bundled`'s. The policy choice for both is to re-add — symmetric across the two reconcilers, documented in their JSDoc, and pinned by regression tests in `test/store.test.js` (`treats user-removed step as stale-older and re-adds it on reconcile` for orderedSubsetReplace; `treats user-removed object-keyed entry as stale and re-adds it` for mergeBy).

Tombstones (e.g. a `_removed: [...]` array in `live`) would let the reconciler honor intentional removals, but expand the live-template schema and the reconciler's surface meaningfully. Out of scope for #155; can be added in a future chunk if a real removal-intent incident materializes.

### Rule

When adding a new array to any bundled template, add a one-line entry to `ARRAY_RECONCILERS` in the same PR that introduces the array. If no existing policy fits (rare — three policies cover string lists, string sets, and object-keyed lists between them), add a new policy function alongside the new entry. The reconciler-update is part of "doing the array right," not a follow-up chore.

The cost of forgetting this is exactly the cost #119, #136, and #158 each paid: an incident, an emergency reconciler patch, and a chunk's worth of cleanup work to re-derive the right state on every install.

---

## Framework-owned subtree sync — value-updates, reorders, renames (#275 extension)

**Status:** extended 2026-05-30 (#275).

The #155 reconcilers are all **additive**: `addMissing` adds absent keys, `_reconcileMergeBy` appends entries with an absent `idKey`, `_reconcileSetUnion` appends absent set members, `_reconcileOrderedSubset` replaces only a strict-subset stale list. None of them **update a matched entry's field values, reorder an array, or drop a renamed-away entry.** That was a deliberate anti-clobber stance (the limitation documented above). But it left a structural blind spot: a bundled change that is a *value-update*, *reorder*, or *rename of an existing entry* never reaches an existing install.

#275 is the incident that named it. Three bundled changes shipped green but were inert on every existing install because each mutated an *existing* entry rather than adding a new one:

| Bundled change | Why additive reconcile missed it | User-visible effect on existing installs |
|---|---|---|
| #264: `critic-check.blocker` `false`→`"errors-only"` | `mergeBy:id` matched `critic-check` → left field values alone | Wrap pipeline never halted on a blocking Critic finding — the safety fix was dead |
| #264: `commit` reordered after `critic-check` | no reconciler reorders | Even if it halted, `commit` had already run |
| #230: action label `"Mark Critic Run"`→`"Run Critic"` | `mergeBy:label` saw a *new* label → appended it, never removed the old | Two buttons; the stale one was vestigial (#266) |

### Policy

Framework methodology policy that lives in specific template subtrees — the wrap-pipeline step list (order + each step's `blocker`/`kind`) and the methodology action buttons (`actions`) — is **framework-owned**, not user-owned. The supported customization path is forking a new methodology `id` via `templates.save`; the settings UI edits project config (engine, methodology, rules), never these subtrees in place.

For framework-owned subtrees we therefore accept a bounded clobber where the additive policy refuses one. `_reconcileFrameworkSubtrees` (`lib/store.js`) replaces the `FRAMEWORK_OWNED_PATHS` subtrees wholesale from bundled, gated by a monotonic integer `schemaRevision` on the bundled template:

- Fires only when `bundled.schemaRevision > live.schemaRevision` (missing/non-integer reads as 0). A bundled template that never sets `schemaRevision` keeps the pure-additive behavior — so `minimal` and any un-revisioned template are untouched, opt-in by construction.
- Fires **exactly once per bump**: after syncing, `live.schemaRevision` is stamped to the bundled value, bounding the clobber to one event per revision and leaving an auditable stamp.
- Never deletes: a path absent from bundled is skipped, not removed from live.
- The live revision is captured **before** `addMissing` runs, because `addMissing` would otherwise copy `schemaRevision` from bundled into live and pre-close the gate.

### Rule

When a bundled-template change mutates an **existing** entry's value, reorders steps, or renames an entry (anything the additive reconcilers structurally cannot deliver), it MUST be paired with a `schemaRevision` bump on that bundled template in the same PR, and the changed subtree must be covered by `FRAMEWORK_OWNED_PATHS`. Pin it with a test that exercises the canonical stale-install shape through `_mergeBundledTemplate` (not just freshly-generated state) — the same "prove the sync delivers the protection on the legacy data shape" rule the #158 anti-pattern established. A bundled value-change without a `schemaRevision` bump is the #275 incident waiting to recur.

---

## References

- #103 — silentPrime feature; established the pattern in PR #125 Critic review
- #119, #136 — bundled-template drift class (first instance of the pattern)
- #137 — silentPrime PATCH-sync gap (closed the silentPrime gate)
- #140 — engine PATCH-sync gap (closed the engine gate)
- #145 — methodology hook `requires` field + bulk-repair (added the runtime-precondition gate)
- #151 — methodology-removal path (currentTemplate hoist + open SQL constraint decision)
- #158 — chunk-1 protection gap on pre-#146 runtime templates; reconciler scope extended to hook entries
- #155 — generalized template-array reconciliation; introduced the `ARRAY_RECONCILERS` policy table and the `mergeBy` policy (Chunk 1: string-array policies; Chunk 2: object-keyed policy + ADR extension)
- #275 — additive reconcile blind spot for value-updates/reorders/renames; introduced `_reconcileFrameworkSubtrees` + `FRAMEWORK_OWNED_PATHS` + the bundled-template `schemaRevision` gate. Inerted #264 (halt) and left #266 (vestigial action) live on existing installs. Pinned by `test/store.test.js → describe('framework-owned subtree sync — schemaRevision gate (#275)')`
- #139 — methodology-aware single-button session wrap; Chunk 2 introduces `wrap_pipeline` schema and the `wrapShapeFromTemplate` read-once shim (see ADR 0002 for the pipeline contract)
- `feedback_symmetric_capability_gates.md` — the user-feedback rule that drove this pattern's discovery
- `test/projects.test.js → describe('methodology flip cleanup audit (#145, chunk 3)')` — the regression test suite locking in the methodology-flip half of this ADR
- `test/projects.test.js → describe('silentPrime (#103)')` — the regression test suite locking in the silentPrime half of this ADR (engine-flip orphan-hook cleanup tests at lines 1074, 1111)
