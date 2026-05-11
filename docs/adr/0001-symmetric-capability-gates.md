# ADR 0001: Symmetric Capability Gates

**Status:** Accepted (2026-05-11)
**Source issue:** #145 chunk 3 (audit closeout)
**Related issues:** #103, #119, #136, #137, #140, #145, #151
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

---

## References

- #103 — silentPrime feature; established the pattern in PR #125 Critic review
- #119, #136 — bundled-template drift class (first instance of the pattern)
- #137 — silentPrime PATCH-sync gap (closed the silentPrime gate)
- #140 — engine PATCH-sync gap (closed the engine gate)
- #145 — methodology hook `requires` field + bulk-repair (added the runtime-precondition gate)
- #151 — methodology-removal path (currentTemplate hoist + open SQL constraint decision)
- `feedback_symmetric_capability_gates.md` — the user-feedback rule that drove this pattern's discovery
- `test/projects.test.js → describe('methodology flip cleanup audit (#145, chunk 3)')` — the regression test suite locking in the methodology-flip half of this ADR
- `test/projects.test.js → describe('silentPrime (#103)')` — the regression test suite locking in the silentPrime half of this ADR (engine-flip orphan-hook cleanup tests at lines 1074, 1111)
