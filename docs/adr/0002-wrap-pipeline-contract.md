# ADR 0002: Wrap Pipeline Contract

**Status:** Accepted (2026-05-14, drafted in #139 Chunk 2). Extended 2026-05-15 (#139 Chunk 3 — runner skeleton + `wrapV2` opt-in shipped behind the flag; #139 Chunk 4 — real `lint` / `test` step handlers + runner halt-condition broadened to `blocker: "errors-only"`).
**Source issue:** #139 — Methodology-aware single-button session wrap
**Related issues:** #136 (template reconciler), #145 (hook precondition gate), #155 (generalized template-array reconciliation), #158 (hook-entry backfill)
**Related ADR:** ADR 0001 — Symmetric Capability Gates (the read-once shim mandated below is an instance of this rule)

---

## Context

TangleClaw's Session Wrap button is, at the time of this ADR, a *prompt fabricator*. `lib/sessions.js:triggerWrap` reads the methodology's `wrap: {command, steps, captureFields}` block, builds a natural-language prompt, and sends it to the AI engine. Whatever the AI does next is the de-facto pipeline. TangleClaw never inspects, orders, or gates the actual steps.

Eight concrete gaps follow from this design (catalogued in #139): janitor pass not run, Critic compliance not verified, tests not gated, durable memory not deterministically updated, priming pointer not rolled by TC, structured output not derived from memory, multi-step commits leaking into the working tree, push-on-main without confirmation. Users have absorbed the gap by performing a *manual* wrap *before* pressing the button — two wraps where there should be one.

The architectural shift #139 enacts: **TangleClaw owns the workflow; the AI owns the content.** Deterministic steps (lint, tests, git ops, version bump, fs reads/writes) execute server-side. The AI engine is invoked only at explicit handoffs for content-generation steps (memory block, structured summary).

This ADR documents the *contract* that the new pipeline runs against. Chunk 2 lands the schema and back-compat shim. Chunks 3–11 implement the runner, step kinds, frontend, and rollout flag. Chunk 12 (optional) extends prompt templates to non-Claude engines.

---

## Decision

A methodology template declares a `wrap_pipeline` block. The Session Wrap button executes the declared pipeline server-side, invoking the AI only on `ai-content` step boundaries.

### Schema

```jsonc
{
  "wrap_pipeline": {
    "schemaVersion": "1.0",
    "promptTemplates": {
      "claude": "Perform a session wrap. ..."
      // codex / gemini variants land via #139 Chunk 12 (or separate issues)
    },
    "steps": [
      { "id": "open-pr-check",   "kind": "pr-check",      "blocker": false },
      { "id": "lint",            "kind": "lint",          "blocker": "errors-only", "scope": "in-session" },
      { "id": "test",            "kind": "test",          "blocker": true,          "allowOverride": true },
      { "id": "critic-check",    "kind": "critic-check",  "blocker": false,         "warnOn": "medium-plus" },
      { "id": "memory-update",   "kind": "ai-content",    "prompt": "Update .tangleclaw/memories/MEMORY.md session block…" },
      { "id": "priming-roll",    "kind": "priming-roll" },
      { "id": "summary-derive",  "kind": "ai-content",    "prompt": "From the MEMORY block above, derive structured output…", "captureFields": ["summary", "nextSteps", "learnings"] },
      { "id": "version-bump",    "kind": "version-bump",  "blocker": false },
      { "id": "commit",          "kind": "commit",        "messageBuilder": "session-content" }
    ]
  }
}
```

### Step kinds (the runner's dispatch table)

| Kind            | Owner   | Behavior |
|---|---|---|
| `pr-check`      | server  | `gh pr list --state open --author @me`; surface open PRs; ask user how to handle. Never blocks. |
| `lint`          | server  | Run project's `lintCommand` on files changed since last wrap. `blocker: "errors-only"` blocks on lint errors but not warnings. `scope: "in-session"` limits findings to commits since last wrap. |
| `test`          | server  | Run project's `testCommand`. Red → block. `allowOverride: true` lets user pass `--skip-tests` from the UI; the skip is recorded in the wrap commit body. |
| `critic-check`  | server  | Heuristic on session history (commit count + line-change count + chunk-tag detection). Warn UI surfaces if heuristic trips and no Critic agent ran. Never blocks; logs skip rationale to MEMORY. |
| `ai-content`    | hybrid  | Server fabricates the per-step prompt from template + session context; sends to AI via tmux; captures output; validates shape. Used by `memory-update` and `summary-derive`. |
| `priming-roll`  | server  | Parse `.claude/plans/<plan>.md` for current chunk pointer; roll forward in `.claude/priming/build-session.md`. Carry blocker annotations through. |
| `version-bump`  | server  | If CHANGELOG has `[Unreleased]` entries and project has a `version.json`, bump and update CHANGELOG. Optional, never blocks. |
| `commit`        | server  | One git commit aggregating all server-side mutations + AI-produced files. Message built from `messageBuilder` strategy. Skip if truly clean. |

### Runner contract

```js
// lib/wrap-pipeline.js (Chunk 3)
async function runWrapPipeline(projectName, options) {
  // returns { ok, blockedAt, results: [{stepId, status, output, blockers, prompt?, aiResponse?}], commitSha, summary }
}
```

Each step returns `{ok: boolean, status: 'done'|'blocked'|'skipped', output: any, blockers: string[]}`. The runner halts the pipeline on `!ok` whenever `step.blocker === true` OR `step.blocker === "errors-only"` — both forms are halt-class. The handler is responsible for deciding what counts as an "error" in the enum case (e.g. lint exits non-zero → `ok: false`); the runner then halts. Any other `blocker` value (`false`, `undefined`, unrecognized strings) never halts — the step result is informational only. The runner is **single-transaction**: server-side mutations stage in memory or a per-pipeline scratch dir; only the `commit` step touches the project's git index. A failure produces no commit; success produces one commit (or zero on a clean session).

The Chunk 4 broadening of the halt condition from `=== true` only to `=== true || === "errors-only"` is deliberate: the schema's `blocker: "errors-only"` form was always specified to "block on lint errors but not warnings" (see the step-kind table above), and an enum that doesn't halt the pipeline would have been misleadingly named. The Chunk 3 runner's `=== true` only check was a placeholder while no real handler returned `!ok`; Chunk 4 collapses the placeholder. Callers reading `step.blocker` for any other purpose MUST use the same disjunction (`=== true || === "errors-only"`) — per ADR 0001 (Symmetric Capability Gates), drift here re-creates the PR #125 incident class.

### Back-compat shim (Chunk 2)

`lib/skills.js` exports `wrapShapeFromTemplate(template)` (and the unchanged `getWrapSkill(methodologyId)`) returning the legacy `{command, steps, captureFields}` shape regardless of whether the source template uses `wrap_pipeline` or the legacy `wrap` block:

- **`wrap_pipeline` present** → `command: null`; `steps` = `wrap_pipeline.steps[].id` in declaration order; `captureFields` = the flattened-and-deduplicated union of every step's `captureFields` array.
- **`wrap_pipeline` absent and legacy `wrap` present** → pass through verbatim (`{command, steps, captureFields}` straight from the template).
- **Neither present** → `null`.

The shim is the single read-point for "what are the wrap steps?" — both `lib/sessions.js:triggerWrap` and `lib/eval-audit.js:scoreWrapQuality` go through it. ADR 0001 mandates this: two files coordinating around the same conceptual state must read through one predicate or the gates drift.

The shim survives until `wrapV2: true` becomes the default in Chunk 11; at that point the legacy `wrap` fallback branch is removable and the dispatch table becomes the source of truth.

### Reconciliation

`wrap_pipeline.steps` is registered in `lib/store.js:ARRAY_RECONCILERS` with `mergeBy: id` policy (#155 Chunk 2). New bundled steps with a new `id` value are appended to live templates on reconcile; existing entries are never mutated. Legacy `wrap.steps` / `wrap.captureFields` reconcilers remain in the table as inert safety nets — bundled templates no longer ship those paths, so the policy table short-circuits when bundled arrays are absent.

ADR 0001's documented limitation applies: a user-removed step is treated as stale and re-added on reconcile. Tombstones would solve it but are out of scope for #139.

### Rollout (Chunks 3 → 11)

The runner ships behind `projConfig.wrapV2` (default `false`, Chunk 3). Existing projects stay on the legacy `triggerWrap` path. The legacy NL-prompt code remains for one release cycle after the default flips (Chunk 11) and is excised in a follow-up. This phased pattern mirrors the engine-config rollout (#119) and the silentPrime rollout (#137) — both shipped behind opt-in flags before defaulting on.

---

## Consequences

### Positive

- **Single source of truth for wrap steps.** The shim (and later, the runner) is the only path that knows the schema. Callers stop reading `template.wrap.steps` directly.
- **Schema is reconciler-aware from day one.** A new bundled step lands in users' runtime templates without a one-shot copy — same pattern that closed #136 / #155.
- **Migration window is bounded.** Chunk 2's shim is dual-shape on purpose; Chunk 11's default flip removes one branch; the follow-up release deletes the legacy `wrap` block reads entirely.
- **Pipeline is declarative.** Adding a new methodology with a different wrap pipeline = a JSON file edit + (if a new step kind is needed) a one-line dispatch-table entry.

### Negative / accepted trade-offs

- **The shim's `captureFields` synthesis is union-of-steps, not stepwise.** Anything depending on "which step's output produces which captureField" can't tell from the legacy shape. No current caller depends on this, but a future caller (e.g., a step-level diagnostic UI) would have to read `wrap_pipeline.steps[].captureFields` directly.
- **`mergeBy:id` does not propagate new `captureFields` values onto an existing step.** A bundled release adding `learnings` to an existing `memory-update` step's `captureFields` array will NOT flow into live runtime templates already on that `id` — the `_reconcileMergeBy` policy is additive only and never overwrites a matched entry's field values (symmetric with `phases` and `actions`). To force the change to propagate, the methodology author must rev the step `id` (e.g. rename `memory-update` → `memory-update-v2`); the reconciler then sees a new id and appends the bundled step. Same operational rule as `phases.id` / `actions.label` versioning — pinned by `_reconcileMergeBy`'s additive-only contract (see ADR 0001's mergeBy section). If stepwise field propagation becomes a real need, the fix is a per-path reconciler that traverses inside matched entries, not a global policy change.
- **`command: null` is forced from the new schema.** Methodologies wanting a custom override prompt go via `promptTemplates.<engine>` once the runner honors it (Chunk 3+). For the migration window, no bundled methodology sets a non-null `command`, so the synthesized null preserves byte-equal `triggerWrap` behavior.
- **Symmetric-gates burden lives in `wrapShapeFromTemplate`.** Any future "read the wrap shape" caller MUST go through this helper, not re-read templates. ADR 0001's incident catalog is the cost of forgetting this; the helper export + the test in `test/skills.test.js` are the enforcement.
- **Legacy reconciler entries (`wrap.steps`, `wrap.captureFields`) stay in `ARRAY_RECONCILERS` until Chunk 11's cleanup.** They're inert, but readers must understand "policy table has the new path AND retains the old paths as safety nets" — a one-line table comment explains this.

### Out of scope (entire #139)

- Auto-dispatch of Critic on missing-Critic detection (deferred; warn + log skip rationale only).
- Tombstone-based "user-removed step X" handling — pipeline is methodology-declared; user customizations either fork the methodology or use a custom one.
- Branch-protection / push-on-main flow — push step lives outside the pipeline.
- Per-step retry with exponential backoff — failure blocks; user fixes and retries.
- Methodology authoring UX — schema is authored by editing template JSON directly.

---

## Migration path (Chunk 2 → Chunk 11)

1. **Chunk 2 (landed 2026-05-14):** Bundled templates ship `wrap_pipeline` block. Legacy `wrap` block removed from bundles. Shim reads both; existing installs continue to function on the legacy path until reconcile picks up the new bundled schema.
2. **Chunk 3 (landed 2026-05-15):** Runner skeleton (`lib/wrap-pipeline.js:runWrapPipeline`) + per-kind step modules under `lib/wrap-steps/` + `projConfig.wrapV2` opt-in flag (default `false`). All eight step kinds dispatch to no-op stubs returning the canonical `{ok:true, status:'done', output:null, blockers:[]}` result. Block-true halt semantics, unknown-kind skip, and thrown-error capture are wired in the runner up-front — Chunks 4–9 only need to fill in step bodies, not touch the dispatch or error-handling skeleton.
3. **Chunks 4–10:** Real step implementations + frontend UI ship behind `wrapV2: false`. Legacy `triggerWrap` path remains the default; new path is dogfooded on opt-in projects.
   - **Chunk 4 (landed 2026-05-15):** Real `lint` and `test` handlers replace the Chunk 3 no-op stubs at `lib/wrap-steps/lint.js` and `lib/wrap-steps/test.js`. Both shell out to `projConfig.lintCommand` / `projConfig.testCommand` (Chunk 3 defaults: `null` → skipped). Test handler honors `step.allowOverride === true` + `options.skipTests === true` → `skipped` with override flag. Lint handler uses `git status --porcelain` to scope to in-session changes; file args are appended after a `--` end-of-options separator and each is single-quote-escaped (`'\''` close-reopen idiom for embedded quotes). Runner extended: (a) `_buildStepContext` threads `options` into `context.options` (defaults to `{}`); (b) halt condition broadened from `=== true` to `=== true || === "errors-only"` per the contract above.
4. **Chunk 11:** `DEFAULT_PROJECT_CONFIG.wrapV2` flips to `true`. Existing projects with explicit `wrapV2: false` keep the legacy path. Migration docs updated.
5. **Post-#139 follow-up release:** Delete the legacy `wrap`-block branch from `wrapShapeFromTemplate`. Remove inert `wrap.steps` / `wrap.captureFields` reconciler entries from `ARRAY_RECONCILERS`. Delete the legacy NL-prompt code from `triggerWrap`. Schema migration complete.

This ADR is the durable home for the architectural pattern. The self-deleting auto-memory `project-issue-139-methodology-wrap.md` retires once #139 closes; this file persists.
