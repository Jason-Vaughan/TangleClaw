# ADR 0002: Wrap Pipeline Contract

**Status:** Accepted (2026-05-14, drafted in #139 Chunk 2). **Default flipped to V2 on 2026-05-19 via #139 Chunk 11c** — see migration-path entry #4 below. Extended 2026-05-15 (#139 Chunk 3 — runner skeleton + `wrapV2` opt-in shipped behind the flag; #139 Chunk 4 — real `lint` / `test` step handlers + runner halt-condition broadened to `blocker: "errors-only"`; #139 Chunk 5 — real `ai-content` step handler with send/poll/capture/validate semantics + `{previousMemoryBlock}` prompt interpolation token). Extended 2026-05-16 (#139 Chunk 6 — real `priming-roll` step handler with plan parsing, managed-block delimiter convention, and staged-write contract; #139 Chunk 7 — real `critic-check` step handler with session-history heuristic + `.tangleclaw/critic-runs.json` read contract + `options.criticSkipRationale` staging). Extended 2026-05-17 (#139 Chunk 8 — real `pr-check` step handler with `gh pr list` integration, session-scope partitioning, and `options.prHandling` resolution staging). Extended 2026-05-18 (#139 Chunk 9 — real `commit` step handler: single-transaction flush of staged writes, `git add -A` + session-derived commit message, `lastWrapSha` stamping on `projConfig`, real `blocker:true` contract with pre-commit-hook surfacing; bundled prawduct / minimal / tilt templates' commit step now declare `blocker:true` explicitly; #139 Chunk 10 — frontend multi-step drawer, `triggerWrap(projectName, options)` second-arg threading, `POST /wrap` accepts `body.options` and surfaces `pipelineResult`, HTTP 200-on-blocked semantics, three decision widgets — `test` override, `critic-check` rationale, `pr-check` resolutions — collected into runner `options` on retry). Extended 2026-05-21 (post-#139 open-queue #2 — bundled prawduct `ai-content` prompts populated for `changelog-update`, `learnings-capture`, `memory-update`; empty-prompt → `skipped` contract preserved via the `minimal` methodology anchor). Extended 2026-05-22 (post-#139 open-queue #3 — real `version-bump` step handler ships at `lib/wrap-steps/version-bump.js`; closes the last #139 Chunk-3 no-op stub; introduces the composite-staged-key convention for multi-file write steps; `lib/wrap-steps/commit.js:_buildBodyLines` gains a deduped `{oldVersion, newVersion, bumpLevel}` duck-type so the wrap commit body carries `- Bumped <old> → <new> (<level>)`). **Extended 2026-05-30 (#264 — wrap-pipeline safety): two paired safety layers ship together.** (a) `lib/wrap-steps/commit.js` now auto-branches when wrap fires on `main`/`master`: creates `wrap/<YYYYMMDDHHmmss>-<project-slug>`, switches, commits there. Escape hatch: `context.options.allowDirectToMain === true` bypasses entirely (for trivial doc fixes / hot-fixes per CLAUDE.md's "direct main commits only for trivial doc edits or incident hot-fixes" carve-out). `output.autoBranched` + `output.originalBranch` surface the decision for Chunk 10's UI to render "Wrap committed on branch X (auto-branched off main)" alongside push/PR affordances. (b) `lib/wrap-steps/critic-check.js` now halts the pipeline when `.tangleclaw/critic-runs.json` has an entry with `ranAt: "actual"` whose `findings` array contains a finding of `severity: "blocking"` (case-insensitive). The bundled prawduct template flips this step's `blocker: false` to `blocker: "errors-only"` so the runner's `step.blocker === "errors-only"` && `!ok` halt condition fires. Operator-override: `options.criticBlockingOverride === true` plus an `options.criticBlockingOverrideReason` string proceeds anyway but stages an `overrideBlockingFindings` entry; `_buildBodyLines` adds an audit-trail commit-message footer line "Critic-override: \<reason\> (\<N\> blocking finding(s) ignored)" so the override survives in `git log` and `gh pr view`. **Why this is an ADR amendment, not just code:** Chunks 7 + 10 explicitly declared `critic-check` `blocker: false` by design. The 631acb5 incident (2026-05-26: a session-wrap commit landed directly on main with a Critic-blocking framework regression, exactly the failure mode the warning-not-halt design left open) is the empirical evidence that warning-not-halt is insufficient under real operator workflows. The override path preserves the operator's authority while the default closes the silent-bypass path. **Methodology authors retain control:** `blocker: false` on the `critic-check` step in a custom methodology template restores warning-only semantics (the runner halts only when `blocker === true || === "errors-only"`). The prawduct template ships `"errors-only"` as the safe default for the methodology that introduced the failure mode; other methodologies opt in explicitly. **Extended 2026-06-11 (#328 — content steps fail loud):** the three prawduct `ai-content` content steps (`changelog-update`, `learnings-capture`, `memory-update`) flip from non-blocker to `blocker: true` + `allowOverride: true`. Previously a `memory-update` timeout returned `ok:false` but, being a non-blocker, let the pipeline reach `commit` — a complete-looking wrap landed with no MEMORY refresh (the silent-partial-wrap bug). Now such a failure halts before `commit`; the drawer offers Retry or a step-scoped "Skip & note" override (`options.skipAiContent[stepId]`, threaded/accumulated across retries by `public/session.js`, staged as `{aiContentSkipped:true}` so `_buildBodyLines` records it). The timeout blocker message no longer hardcodes "wrap pipeline blocked" (it described the pipeline, which the handler can't know) — it now names the step + "no idle detected" with an `output.remediation`. No double-bump risk: `version-bump` stages in-memory and only `commit` flushes, so a halt evaporates staged writes and retry re-derives. **Extended 2026-07-04 (#467 — auto-PR close-loop):** the #264 auto-branch left wrap commits dangling on their `wrap/<ts>-<slug>` branches — nothing landed them, so version bumps, CHANGELOG promotions, and self-healed index files (#423/#425) never reached the protected branch and were re-created on every subsequent wrap. The commit step now closes its own loop after an auto-branched commit: `git push -u origin <wrap-branch>`, `gh pr create` back to the original branch (What/Why body embedding the wrap commit's body lines, best-effort `chore` label), `gh pr merge --auto --squash --delete-branch` (branch protection still gates — this removes the wait, never the checks), then `git checkout <originalBranch>` on full success only. Every sub-step is **non-fatal** — the commit already landed; failures degrade to `output.autoPr.{skippedReason|error, remediation}` and HEAD stays on the wrap branch as the visible manual-rescue cue. Gates: per-project `projConfig.wrapAutoPrEnabled` opt-out (default **true**), no-`origin`-remote skip, `gh`-unavailable → push-only. `output.autoPr` is `null` when no auto-branch happened; the drawer's commit row renders the outcome on its detail line. **Extended 2026-07-18 (backlog WRP-2Q6H — legacy path excised):** the follow-up strip promised at the Chunk-11c flip finally landed (many release cycles late): `triggerWrap`'s legacy NL-prompt-via-tmux branch and the `projConfig.wrapV2` gate are deleted — the pipeline runner is the only wrap path, `wrapV2` is no longer seeded into project configs, and stale on-disk `wrapV2` keys are ignored. The `lib/skills.js` shim survives (contrary to the original strip plan): `getWrapSkill`/`wrapShapeFromTemplate` are still consumed by the pipeline's response shaping, `autoCompleteWrap`, skill listing, and `lib/eval-audit.js` — and the bundled templates still carry legacy `wrap` blocks, whose retirement belongs to the methodology-layer removal (Prawduct V2 sunset Phase B). **Extended 2026-07-19 (#570 — step-inventory cleanup):** the dispatch table's orphans are resolved. The `critic-check` step and handler are DELETED — #353 moved governance to the Prawduct plugin, leaving the step dispatched but referenced by no bundled template, and the prawduct `Run Critic` action still promising "the wrap step's critic-check will pass" (the #570 defect). Deleted with it: the `options.criticSkipRationale` option, the drawer's `warningWidgetForStep` rationale textarea, and `commit.js`'s Critic skip-rationale / `Critic-override` (#264) commit-body lines. The `output.warning` channel itself survives as a kind-agnostic contract. `lint` and `test` stay as opt-in primitives (dispatched, unreferenced by bundled templates, available to any template that declares them) — the runner's `blocker:"errors-only"` branch is retained for `lint`. Dead `wrap_pipeline.promptTemplates` is removed from both bundled templates (never read: the runner consumes only `.steps`). The inert `wrap_contract` layer is removed — `continuity-write`'s methodology-default fallback, its `getMethodologyTemplate` seam, and `methodologies.validateTemplate`'s validation of a field no bundled or live template declared; per-project `wrapSections` remains the wrap-section control. **`open-pr-check` becomes a real gate, and gains a sibling (operator decision 2026-07-18/19):** it validated `options.prHandling` resolutions and never applied them. **Gate:** `open-pr-check` (`blocker: true`) blocks when a session-scoped open PR carries no resolution, or when a supplied resolution is invalid — a half-understood request never half-applies. It stays read-only: it stages the decisions for `commit` to record and never touches the remote — the `gh pr merge` helper lives in `pr-merge.js`, so the capability is absent from the gate's module, not merely unused. (The re-home also puts the `gh` call under `pr-merge`'s exec envelope — 60s timeout, 1MB buffer — rather than `pr-check`'s 30s/5MB. Intentional: this call can wait on GitHub, and its output is a short status line.) **Apply:** a new `pr-merge` kind (`lib/wrap-steps/pr-merge.js`, step id `apply-pr-resolutions`, LAST) reads the staged resolutions and runs `gh pr merge <n> --auto --squash --delete-branch` for each `merge`. **Why two steps:** the halves have opposite ordering requirements. Blocking is only cheap before the ai-content steps have prompted the session and before `commit` lands, so the gate must precede them (`preflight`, added 2026-09-03, runs ahead of it and writes nothing); but the merge targets the PR the wrap commit belongs to, so enqueueing it before `commit` would merge a PR missing that commit and `--delete-branch` could delete the branch mid-wrap. **Running after `commit` is necessary but not sufficient:** `commit` pushes only on the auto-branch path, and a session-scoped PR is by definition on a feature branch — exactly the path where the wrap commit stays local. `pr-merge` therefore pushes the branch (`git push -u origin <branch>` when HEAD is ahead of `origin/<branch>`, or that ref does not exist yet — measured against `origin`, not the tracking ref, since a fork or second remote can leave `@{u}` level while `origin` lacks the commit) before enqueueing, and enqueues nothing if the push fails or HEAD is detached: a stale PR is recoverable, a PR merged and branch-deleted without the wrap commit is not (the #447/#450/#453 dangling-wrap class). Auto-merge rather than an immediate merge means branch protection and required checks still decide when it lands — a wrap can never force a merge over red checks. **The apply step never blocks** (`blocker: false`): it runs after `commit`, so a halt there would strand a half-finished wrap whose session lifecycle never completes, and a failed enqueue (auto-merge disabled, PR closed) is not something a retry fixes — it surfaces as `output.warning` + remediation instead. `defer`/`ignore` are recorded-only; `ignore` is the escape hatch, since the gate demands a decision, not a particular one. Degradation is unchanged and still never blocks (no `gh`, no auth, non-GitHub remote, probe throw → `skipped`): not knowing is not the same as knowing something is wrong. The commit body records the operator's decisions, never an outcome — `commit` runs before the merge is enqueued, so claiming a result there would be a guess. **Extended 2026-07-19 (#540, #571 — `version-bump` fails closed):** the step's "never blocks" contract is unchanged, but "never blocks" had drifted into "never refuses": three inputs it could not honor silently became a different action. (a) Version-file resolution was a fixed probe of lowercase `version.json` then `package.json`, so a project whose file is `VERSION.json` resolved nothing on a case-sensitive filesystem, fell through, and bumped an unrelated `package.json` — writing a bogus release heading above the real one. A new per-project `versionFilePath` (relative, validated against escaping the project root at BOTH the API and the write site, since a hand-edited `.tangleclaw/project.json` never passes through the validator) is the sole candidate when set: it resolves or the step skips, and **never falls back**. (b) The #203 drift guard read `if (topReleased && …)` and `_topReleasedVersion` returns null for any heading that isn't `## [X.Y.Z] - YYYY-MM-DD`, so on the very 4-octet schemes that trigger (a) the guard skipped *itself*. A new `_classifyTopRelease` replaces the boolean guard with an exhaustive classification of the newest release heading: `none` (no release yet — a first release, still bumps), `released` (plain 3-octet semver, comparable, drift-checked), `unbumpable` (semver carrying a prerelease/build suffix, whose ordering against a plain version is ambiguous — stops), `foreign` (another scheme entirely — stops). **One classifier, because two predicates kept disagreeing.** The guard must answer both "can I compare against this heading?" and "is this a scheme I recognize?", and each two-regex attempt drifted apart in review: the strict parser alone self-skipped on any other format (the original fail-open); adding a looser companion check hard-skipped undated or en-dashed headings and blamed their "versioning scheme"; widening that companion to accept `## [2.0.0-beta.1]` then made it report not-foreign while the parser still returned null, so the wrap fell through the first-release branch and skipped the guard entirely — reopening the fail-open one door down, where it would have written `## [1.0.1]` directly above the beta. A single classification cannot disagree with itself, and the caller branches on every kind. (c) An `options.bumpLevel` outside `patch|minor|major` fell through to the heuristic, turning a typo into a different bump with no signal; it now skips naming the value. **Why this is an ADR amendment:** the step-kind table's "Optional, never blocks" was being read as license to proceed on unrecognized input. Never-blocks governs the *pipeline* (a skip returns `ok:true` and the wrap continues); it does not license *acting* on an input the step cannot interpret. Every refusal is now also logged, not just the success — a skip was previously visible only in the live drawer, so after it closed a deliberate refusal and a step that never ran were indistinguishable, which is the question #540 was filed to answer. **Extended 2026-07-20 (#538 first half — the pipeline declaration moves from data to code):** the contract's source statement is superseded: the wrap pipeline is no longer declared by a methodology template's `wrap_pipeline` block — the step list (ids, kinds, blockers, prompts, capture config) is code-owned in `lib/wrap-default-pipeline.js`, one shared pipeline for every project, ported byte-identical from the prawduct template's 14 steps. `runWrapPipeline` no longer reads `store.templates`; forking a methodology id has no wrap effect. Per-project variation is exclusively `wrapStepOverrides` + the dedicated effect toggles (the #643 contract, unchanged). `getWrapSkill` is deleted — its consumers (`_triggerWrapV2` response shaping, `autoCompleteWrap`) now read `wrapShape()` from the code-owned module, and `eval-audit.scoreWrapQuality` takes the project's effective (override-filtered) step ids instead of a template. Projects labeled `minimal` (commit-only wrap by empty-prompt self-skip) are migrated behavior-preservingly: a one-shot seed writes `wrapStepOverrides` disabling every step except `commit`, stamped with `wrapOverridesSeeded` so clearing the map is a durable opt-in to the full pipeline. The methodology layer's remaining surfaces (chooser, templates, registry, `methodology` field) are removed in #538's second half. **Extended 2026-09-03 (#854 — a `preflight` kind, and the pipeline's first step):** `lib/wrap-steps/preflight.js` asks prawduct for the verdict its session-end Stop hook would give, BEFORE any step writes to the tree — the block otherwise arrived after `changelog-update` and `version-bump` had already run, leaving a half-applied wrap. It is position 0 by contract, ahead of `open-pr-check`, and `blocker: false` by default: blocking would deadlock prawduct's reflection gate against the wrap's own content steps, its Critic gate is minutes of agent time that belongs opted into per project, and the escape hatch means writing another framework's state. An unmet gate is a `blocked` row carrying the hook's own text plus `output.warning`; `wrapStepOverrides.preflight.blocker: true` makes it halt instead. **Why this is an ADR amendment and not just a step:** it is the first kind that CALLS across the prawduct seam rather than reading a value across it, which ADR 0011 item 3 required an amendment for — see its 2026-09-03 entry, which also records that the hook's own `record_grants` append means invoking it can write inside `.prawduct/`. Every way the dependency can fail — hook absent, probe killed, spawn refused, an exit code outside the hook's 0/2 contract — is reported as **gates not measured**, never as a verdict, because a step claiming clear gates it never checked is the false report the drawer exists to end. **Extended 2026-09-06 (#1132 — one managed-block policy):** the priming file's managed block is no longer spliced by this step's own code. `lib/managed-block.js` owns the splice, and `lib/engines.js`'s engine-config merge splices through it too, so the two cannot answer "what does a broken marker set mean" differently — which they did: the engine layer refused and left the file byte-identical, while this step treated a misordered pair as "no block" and appended a fresh one. The append was not idempotent, so the next wrap saw the same misordered pair and appended AGAIN, one stale block per wrap forever. **The shared policy is decided by the marker COUNTS**, because a marker literal is not proof the marker is TangleClaw's — an operator documenting this mechanism inside the file it edits writes both literals in their own prose, and nothing in the text separates those from a real region. Exactly one begin and one end is our region: spliced in place when they are in order, and REPAIRED into one well-formed block when they are not, with the text that was between the misordered markers kept below it. None of either appends a fresh block. Every other count is refused and the file is left byte-identical, which is what the old append got wrong (it grew the file) and what adopting the first of several pairs would get wrong (it would delete an operator's prose). A repaired file holds one well-formed pair, so a second pass is byte-identical and the file stops growing; because a repair moves bytes outside the managed region, the splice reports it and this step logs it and puts `repaired` on its own output row. **Why this is an ADR amendment, not just a refactor:** the Chunk 6 entry below records "when the markers don't exist yet, the handler appends a fresh managed block" as the contract, and a broken pair was read as that case; it is now a third case with its own answer. `_replaceManagedBlock` also changes shape — it returns `{merged, error}` rather than a string, because one input is still refused: a rendered body carrying a marker literal (a plan chunk heading can) would write a boundary the operator never authored, and the wrap after that would read their prose as our region and delete it. Repair cannot undo that, since the file would LOOK well formed, so the step reports `blocked` with the reason instead of writing. **Extended 2026-09-14 (#1312, #1229 — the drawer becomes a popover, and a handback is watched):** the Chunk 10 drawer is now a non-modal popover on the Wrap button (no backdrop; a 60vh sheet on a phone). The page's controller separates toggling it closed (`hide`/`show`, which keep a settled report and its widget choices) from finishing with the run (`dismiss`). The Wrap button stays enabled during a run and is its surface: step N/M and the current step's elapsed time, measured on the server's clock — registry events carry `at`, SSE frames carry `sentAt`, and `/wrap/status` reports `currentStepStartedAt` — amber past two minutes. **"Ask the session to fix this" is watched:** `POST /wrap/handback` (`lib/wrap-handback.js`) is refused unless the latest run settled halted at that step, appends the content step's own completion instruction with a fresh nonce, injects through `sessions.injectCommand`, and watches the pane with the content step's constants. Watched, it is `working` or `quiet` (the quiet window passed with no marker; back to `working` when the pane moves); it ends `ready` on the marker, `timed-out` after the maximum wait since it last started working, `quiet` at a 30-minute cap, `failed` on an unreadable pane, or `superseded` when another handback or a new run replaces it. `quiet` is deliberately neither `ready` nor an ending: in the live check a session handed a gate it would not fake stopped to ask the operator, and silence cannot tell that from finished, while the operator's answer can still lead to the marker. So the drawer lights Retry only on the marker and never gates Retry on any state. Only content and preflight blocks can be handed back (`WRAP_STEP_NOT_RESOLVABLE` otherwise). The outcome streams on `GET /wrap/handback/stream/:handbackId` (a separate stream, because a settled run's stream has already sent its terminal frame) and restores from `/wrap/status`'s `handback`. **`preflight` gains `allowOverride: true`** and honours `options.skipPreflight` ("Wrap anyway") by skipping without re-probing and staging `{preflightOverride: true}`, which `_buildBodyLines` records as the gates passed over; the drawer keeps the choice across retries because every retry re-runs preflight. A halting preflight is `agentResolvable`, so the handback carries prawduct's block text to the session — TangleClaw sends a prompt and invokes no agent itself, so ADR 0011 item 5 is not engaged, and it still writes no waiver (item 3). **Extended 2026-09-14 (#1492 L3 — `version-bump` halts on an unmade release decision):** `releaseMode` (`off`/`auto`/`ask`) and the files-only readiness verdict decide whether a wrap may cut, and two outcomes are questions only the operator can answer: `ask` on any wrap with a release to cut, and `auto` when readiness is `unknown`. The step used to skip on both with `needsOperator: true` in its output, and the wrap then committed with no release and no one asked. Now, when no decision was sent, the step returns `{ok:false, status:'needs-operator'}` carrying `wouldBump` and the readiness signals, and the pipeline declares `version-bump` `blocker: true`, so the run halts before `commit`. The drawer renders a Cut / Hold choice with neither preselected, and Retry carries it as `options.release` (`cut`/`hold`, absent for Auto), which the page keeps for the rest of the wrap. The wrap modal's bump-level picker becomes a Release: Auto / Cut / Hold control, with the level offered only under Cut and the control hidden for an `off` project. **Why this is an ADR amendment:** the step-kind table said version-bump "never blocks", and the 2026-07-19 entry above read that as governing the pipeline. Proceeding past an unanswered release question takes the decision for the operator, which is the silent-wrong-answer class that entry exists to refuse, so this one case now stops the pipeline instead of the step skipping. Everything else stays a skip, a plain `not-ready` hold included. **The halt rides the blocker flag, not a runner rule.** The runner halts only on `blocker: true|"errors-only"` with `!ok`, and version-bump returns `!ok` for nothing but this halt. So two consequences follow, both accepted: a version-bump handler that throws now halts too, where it used to let a wrap commit without the release it was meant to write; and `wrapStepOverrides['version-bump'].blocker: false` restores continue-on-hold, with the row still reading `needs-operator`. Making the runner halt on any `needs-operator` regardless of the flag was rejected: it would change every step's contract to serve one step, and it would override an operator's existing `blocker: false` on a content step. A halt here costs no re-prompt, because the content steps before it are reused on Retry under #1404's window. The L2 AI recommendation, and halting when it disagrees with L1, are left to a later amendment. **Extended 2026-09-15 (#1510, #1512 — the boundary leaves `project.json`, and `session-files` can ask a second question):** the Chunk 9 entry records `lastWrapSha` stamping on `projConfig`; the boundary is now stamped in the untracked `.tangleclaw/state.json` (`lib/wrap-state.js`), because a value rewritten on every wrap inside a tracked file left every next session dirty. `commit._readLastWrapSha` keeps its `recorded`/`absent`/`unreadable` contract (#797). `session-files` gains a `needs-operator` outcome for the one-time offer to stop tracking TangleClaw state files, answered by `options.untrackState` (`approve`/`decline`); it is asked only after every Include / Leave choice is settled, so one Retry never carries two kinds of question. `commit` carries an approval as a removal from tracking in the same wrap commit. Because `git commit <pathspec>` re-reads each listed path from the working tree and so cannot carry a removal of a file still on disk, that one case builds the commit on a temporary index started from HEAD and brings the real index level afterwards; everything the operator staged stays staged and out, the same guarantee the pathspec commit gives (#1406). **Extended 2026-09-15 (#1513 — what a file *holds* can block the commit):** until now the pipeline decided what to commit only by who changed a file. Both `session-files` and `commit` now also scan file contents (`lib/wrap-steps/_secret-check.js`, over `lib/secret-scan.js`), and a file matching a credential rule takes a `needs-operator` outcome answered on the existing `options.pathDecisions` key rather than a new one — the drawer renders Include / Leave only for those two step kinds, so a separate step would block with no way to answer it. This widens `pathDecisions` beyond #1406's "files the session did not change": a flagged path may be one the session *did* write, and `output.foreignPaths[].secretRules` names the rules so the surface asking the question can say which kind it is. `commit` scans a second time after the staged-write flush, because that content is what git records; an Include already given stands for the rest of the wrap. Scans carry rule names only — `scanText` returns types, never matched text, so no channel (output, blockers, log, the `wrap.secret_scan` activity row) can leak a credential. The scan is bounded by file size, file count and total bytes; past a budget the remaining candidates are reported as skipped with the reason, never silently treated as clean. Binary content is judged from a prefix the size of what the text heuristic samples, so the verdict is unchanged while a binary costs one small read rather than its full length, and a read that ends in a skip still counts against the budget — the budget measures work done, not files successfully scanned.
**Source issue:** #139 — single-button session wrap
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
      { "id": "preflight",      "kind": "preflight",     "blocker": false },
      { "id": "open-pr-check",   "kind": "pr-check",      "blocker": true },
      { "id": "lint",            "kind": "lint",          "blocker": "errors-only", "scope": "in-session" },
      { "id": "test",            "kind": "test",          "blocker": true,          "allowOverride": true },
      { "id": "memory-update",   "kind": "ai-content",    "prompt": "Update .tangleclaw/memories/MEMORY.md session block…" },
      { "id": "changelog-update","kind": "ai-content",    "blocker": true, "allowOverride": true, "verifyChanged": ["CHANGELOG.md"] },
      { "id": "priming-roll",    "kind": "priming-roll" },
      { "id": "summary-derive",  "kind": "ai-content",    "prompt": "From the MEMORY block above, derive structured output…", "captureFields": ["summary", "nextSteps", "learnings"] },
      { "id": "version-bump",    "kind": "version-bump",  "blocker": false },
      { "id": "commit",          "kind": "commit",        "messageBuilder": "session-content" },
      { "id": "apply-pr-resolutions", "kind": "pr-merge", "blocker": false }
    ]
  }
}
```

### Step kinds (the runner's dispatch table)

| Kind            | Owner   | Behavior |
|---|---|---|
| `pr-check`      | server  | `gh pr list --state open --author @me`; surface open PRs; ask user how to handle. BLOCKS on a session-scoped PR with no `merge`/`defer`/`ignore` resolution (2026-07-19 amendment, #570). Read-only: stages the decisions, never touches the remote. Degraded probes skip without blocking. |
| `pr-merge`      | server  | Applies the staged resolutions after `commit`: pushes the branch so the PR contains the wrap commit, then `gh pr merge <n> --auto --squash --delete-branch` per `merge`. Never blocks — a failed push or enqueue surfaces as `output.warning` + remediation and nothing is enqueued (2026-07-19, #570). |
| `lint`          | server  | Run project's `lintCommand` on files changed since last wrap. `blocker: "errors-only"` blocks on lint errors but not warnings. `scope: "in-session"` limits findings to commits since last wrap. |
| `test`          | server  | Run project's `testCommand`. Red → block. `allowOverride: true` lets user pass `--skip-tests` from the UI; the skip is recorded in the wrap commit body. |
| `ai-content`    | hybrid  | Server fabricates the per-step prompt from template + session context; sends to AI; captures output; validates shape. Used by `changelog-update`, `release-recommendation`, `learnings-capture`, `memory-update`. **`verifyChanged: string[]` (2026-07-19 amendment, #571/#638):** for a content step whose job is a FILE EDIT, names the project-relative paths that must actually change. The handler snapshots each path before sending the prompt and, once the step has finished, blocks unless at least one differs (created / deleted / content-changed). Without it the only success gate for a step with no `captureFields` is a ≥20-char reply, so the AI can answer "done" without touching the file and the step still reports `done` — the honor-system hole this closes. A path unreadable both before and after reads as unchanged, so an unverifiable edit blocks rather than passing. Tmux path only (the gateway path can't read the local tree and already returns an honest `skipped` for a file-edit step); the blocking steps that declare it all precede `commit`, so the halt is reachable. **Transport-aware (CC-7 Slice B1):** a **tmux** session sends via `tmux.sendKeys` → polls the recent pane for completion → captures the pane; a **webui** session sends over the ClawBridge gateway (`clawbridge.send` → poll `getStatus` until `inputReady` → read the structured block from the step's `captureFile` via `clawbridge.getFile` consume-once, ClawBridge #18) — both parse with the same `_parseFields` `## Heading` parser. A webui step with no `captureFile`, or a session with no bridge sidecar, returns an honest `skipped` (the gateway PTY stream can't carry structured fields — Slice B1 spike). **Content steps declare `blocker: true` + `allowOverride: true` (#328):** a timeout/validation failure halts the pipeline *before* `commit` (no silent partial wrap); the operator either waits + Retries, or ticks "Skip & note" (`options.skipAiContent[stepId]`) to wrap without that step, recorded in the commit body. An empty-prompt step still `skipped`s (ok:true) and never halts. **`optionalCaptureFields: string[]` (2026-09-10 amendment, #1379/#1389):** fields the step WANTS but cannot require. They are unioned with `captureFields` before parsing and staged identically, but validation filters on `captureFields` alone, so an absent one never blocks. The union is the load-bearing half: `_parseFields` matches a `## Heading` only against names it was handed, so a field in neither list is not optional but unparseable — and an unmatched heading is appended to whichever section is still open rather than skipped, so omitting a name corrupts the section before it. **Why a second list rather than a looser gate:** the wrap's four judgment sections (`Delta` / `Open threads` / `Decisions` / `Pointers`) must be asked for on every engine and supplied by none in particular. `wrap-direction.md` § Direction (2) holds that a step never hard-fails the wrap for lacking one engine's feature, and (3) permits a blocking gate only where failure is silent or destructive; a judgment section the AI omitted is neither, since `continuity.renderWrapSummary` renders a visible `_⚠ not captured_` and nothing is lost. The first attempt at #1379 put all four in `captureFields` and so made every wrap depend on a model emitting seven blocks. Like `captureFields`, the new key is absent from `lib/wrap-step-overrides.js`'s allow-list — other subsystems read these fields by name. `wrapShape().captureFields` reports the union, matching its documented "fields this wrap MAY produce" contract. **Completion (2026-09-14 amendment, #1450):** a tmux step used to finish when `sessions.detectIdle` saw the pane's last 3 lines unchanged for 10s. A TUI's input box and footer hold still while the model thinks, so the next step's prompt could land in a turn still in progress. Each tmux prompt now ends with an instruction to print `TCWRAP-DONE` and a fresh per-send nonce. Each poll checks, in order: the marker in the recent pane (`PANE_TAIL_LINES`); the #672 file-settle signal, once the marker has had `MARKER_GRACE_MS` (15s) more to appear, because an AI writes its file and then composes its reply; and `QUIET_FALLBACK_MS` (60s) of a byte-identical recent pane. The result records `output.completedVia` (`marker`/`files`/`quiet`), and a quiet finish adds `output.completionNote`. **Why the marker is not the only signal:** a step that finished only on it would stall every wrap on an engine that does not echo it reliably. That is the single-engine dependency `wrap-direction.md` commitment 2 forbids, and the reason #840 declined a run-id stamp. The marker makes capable engines exact, and its absence degrades visibly. **`verifySatisfiedBy: 'learnings-entry'` (2026-09-14, #843/#1405):** the second satisfaction predicate, declared by `learnings-capture`. The file must have been written since the session started and carry an entry dated within it, so an entry that landed before the step, or before a Retry, passes. Predicates dispatch through `SATISFACTION_PREDICATES`. **`precondition` (2026-09-14 amendment, #1492):** names a predicate in `PRECONDITIONS` that decides whether the prompt could change anything this wrap. A closed precondition returns `skipped` with its reason before the session or transport is looked at, so the tmux and gateway paths can't answer differently. The runner's `step N of M` roster asks the same predicate with `planning: true`, which limits it to facts no earlier step changes. An unregistered name skips and names the bug. Not overridable. See the extension at the end of this ADR. |
| `priming-roll`  | server  | Parse `.claude/plans/<plan>.md` for current chunk pointer; roll forward in `.claude/priming/build-session.md`. Carry blocker annotations through. |
| `version-bump`  | server  | If CHANGELOG has `[Unreleased]` entries and the project has a resolvable version file, bump and update CHANGELOG. Optional, and blocks in one case only: a release decision that is the operator's and hasn't been made halts with `needs-operator` (2026-09-14 amendment). In `auto` that includes a readiness verdict the `release-recommendation` step disagrees with (`ready` + hold, `not-ready` + cut). Otherwise never blocks — and refuses (skips, with a reason) rather than guessing when an input can't be honored. See the 2026-07-19 fail-closed amendment. |
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

### Release outcome is NOT a step result (2026-07-19 amendment, #638)

`pipelineResult.ok` means *"nothing declared itself a blocker"* — not *"the work
shipped."* When the `commit` step auto-branches off a protected branch it opens a
wrap PR and **arms** GitHub auto-merge, then returns; the version bump and
CHANGELOG promotion only reach the base branch once that PR merges server-side.
So the release outcome resolves strictly *after* the pipeline returns and cannot
be a step result at any position.

Two consequences bind on consumers:

1. **A committed wrap is not a shipped release.** A commit with an armed-but-
   unmerged wrap PR renders `provisional` ("release pending PR merge"), never
   plain success. On #636 a red required check left the PR blocked, `main` never
   moved, and every step read `[Done]` — including `version-bump` reporting a
   bump stranded on an unmerged branch.
2. **The true outcome is a read-only, on-demand probe.**
   `GET /api/sessions/:project/wrap/pr-status?url=<prUrl>` runs `gh pr view
   --json state,mergeStateStatus,statusCheckRollup` and maps to `merged | pending
   | blocked | unknown` (`lib/wrap-pr-status.js`). `blocked` MUST NOT render as
   success; `unknown` (no `gh`, probe failure) stays honestly indeterminate
   rather than claiming either result. The drawer resolves once on render and
   offers an explicit "Recheck release" button — no polling timer, per the
   no-timer-driven-UI rule.

   **Extended 2026-07-22 (#686 — `blocked` discriminates on the check rollup,
   not the `BLOCKED` string):** GitHub reports `mergeStateStatus: BLOCKED` for
   *any* unmet branch-protection condition — including a required check that is
   merely still **running** — so reading bare `BLOCKED` as failure mislabeled an
   armed wrap PR whose CI was mid-flight ("release BLOCKED, did not ship", the
   Recheck button repeating it) seconds before auto-merge shipped it. `classify`
   now reserves `blocked` for a genuine dead-end: `state=CLOSED` (closed
   unmerged), `OPEN`+`DIRTY` (branch conflicts), or an `OPEN` PR with a
   `statusCheckRollup` entry whose conclusion is terminally failing
   (`FAILURE`/`ERROR`/`TIMED_OUT`/`CANCELLED`/`ACTION_REQUIRED`/`STARTUP_FAILURE`/
   `STALE`). Everything else open-and-not-failed — checks pending, `CLEAN`/
   `UNSTABLE`/`BEHIND`, or a bare `BLOCKED` with no failing check (e.g. a
   missing required review) — is `pending`. This preserves the #636 red-check
   guard through the check's own conclusion instead of the ambiguous merge-state
   string. If required reviews are ever enabled on wrap PRs, a review-only block
   reads `pending` rather than surfacing as review-needed — revisit then.

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
- Tombstone-based "user-removed step X" handling — pipeline is methodology-declared; user customizations either fork the methodology or use a custom one. **Superseded in part 2026-07-19 — see "Extended 2026-07-19" below: a project may now disable or reconfigure a step without forking, though it still cannot add, remove, or reorder one.**
- Branch-protection / push-on-main flow — push step lives outside the pipeline.
- Per-step retry with exponential backoff — failure blocks; user fixes and retries.
- Methodology authoring UX — schema is authored by editing template JSON directly.

---

## Extended 2026-07-19 — per-project step overrides

The pipeline is no longer read *solely* from the methodology template. The runner now resolves
each template step against a per-project `wrapStepOverrides` map (`.tangleclaw/project.json`,
keyed by `step.id`) before dispatch; `lib/wrap-step-overrides.js` owns the resolution and the
rules below.

**Why the overrides can't live in the template.** `wrap_pipeline.steps` is in
`FRAMEWORK_OWNED_PATHS`, so the boot-time reconcile replaces that subtree wholesale whenever a
bundled template ships a higher `schemaRevision` (ADR 0001). A project hand-editing its template
to turn one step off therefore loses the edit at the next boot after a framework bump — silently,
since the sync is a normal startup event. `project.json` is written by no template-sync path, so
overrides stored there survive by construction rather than by convention.

**What stays framework-owned, and why it isn't merely conservatism.** Order and membership are
not overridable. Wrap step order encodes correctness contracts *between* steps — the changelog
must be written before `version-bump` reads it to derive a level, and both before `commit`
flushes them — and those contracts are guaranteed by a single fingerprint check against the
bundled step list. Per-project ordering would convert one global, checked property into a
per-project property nothing checks, which is the shape of the defect that motivated the
verification work in the first place. (The fork-a-methodology escape hatch this paragraph
originally offered no longer exists — see the 2026-07-20 amendment below.)

**The overridable set is an allow-list** (`enabled`, `blocker`, `prompt`), enforced at the API
and again in the runner because a hand-edited `project.json` never passes through the API. Two
exclusions are load-bearing rather than incidental:

- `verifyChanged` is not overridable. It names the files a content step must actually have
  changed to count as done; emptying it would leave the verification reporting success while
  checking nothing.
- A `commit`-kind step cannot be disabled. It is the sole `_flushStagedWrites` caller, so
  disabling it produces a run where every staging step reports done and nothing reaches disk.
  Keyed on `kind`, not `id`, so a renamed commit step is equally protected.

`blocker` **is** overridable, and the line between it and the exclusions above is honesty rather
than strength: a step made non-blocking still runs, still verifies, and still reports `ok:false`
in the drawer — it only stops halting the pipeline. A visible escape valve is a configuration; a
self-concealing one is a defect.

A disabled step records `status:'skipped'` with a reason in the results array rather than being
omitted, preserving the invariant that the result set describes the whole declared pipeline.

---

## Migration path (Chunk 2 → Chunk 11)

1. **Chunk 2 (landed 2026-05-14):** Bundled templates ship `wrap_pipeline` block. Legacy `wrap` block removed from bundles. Shim reads both; existing installs continue to function on the legacy path until reconcile picks up the new bundled schema.
2. **Chunk 3 (landed 2026-05-15):** Runner skeleton (`lib/wrap-pipeline.js:runWrapPipeline`) + per-kind step modules under `lib/wrap-steps/` + `projConfig.wrapV2` opt-in flag (default `false`). All eight step kinds dispatch to no-op stubs returning the canonical `{ok:true, status:'done', output:null, blockers:[]}` result. Block-true halt semantics, unknown-kind skip, and thrown-error capture are wired in the runner up-front — Chunks 4–9 only need to fill in step bodies, not touch the dispatch or error-handling skeleton.
3. **Chunks 4–10:** Real step implementations + frontend UI ship behind `wrapV2: false`. Legacy `triggerWrap` path remains the default; new path is dogfooded on opt-in projects.
   - **Chunk 4 (landed 2026-05-15):** Real `lint` and `test` handlers replace the Chunk 3 no-op stubs at `lib/wrap-steps/lint.js` and `lib/wrap-steps/test.js`. Both shell out to `projConfig.lintCommand` / `projConfig.testCommand` (Chunk 3 defaults: `null` → skipped). Test handler honors `step.allowOverride === true` + `options.skipTests === true` → `skipped` with override flag. Lint handler uses `git status --porcelain` to scope to in-session changes; file args are appended after a `--` end-of-options separator and each is single-quote-escaped (`'\''` close-reopen idiom for embedded quotes). Runner extended: (a) `_buildStepContext` threads `options` into `context.options` (defaults to `{}`); (b) halt condition broadened from `=== true` to `=== true || === "errors-only"` per the contract above.
   - **Chunk 5 (landed 2026-05-15):** Real `ai-content` handler replaces the Chunk 3 no-op stub at `lib/wrap-steps/ai-content.js`. Handler sends the (optionally-interpolated) `step.prompt` via `tmux.sendKeys`, polls `sessions.detectIdle` until idle is reported (cap: 5 min), captures full pane scrollback, and validates the result. If `step.captureFields[]` is set, each field must appear as a `## Heading` block with non-empty content; otherwise the handler asserts only a ≥20-char non-trivial response. Successful captures stage in `context.staged[step.id] = {capturedText, parsedFields}` for the eventual `commit` step (Chunk 9) to consume. **Prompt interpolation:** one token in Chunk 5 — `{previousMemoryBlock}` is replaced with the captured text of the prior step whose `stepId === 'memory-update'` (and whose `status === 'done'`); unrecognized braces pass through verbatim. The handler is the same code path for both `memory-update` and `summary-derive` step instances — only the `step.prompt` and `step.captureFields` differ. **Module-load cycle:** `lib/sessions.js` is lazy-required inside the `detectIdle` adapter to break the `sessions.js → wrap-pipeline.js → wrap-steps/ai-content.js → sessions.js` chain; at call time the cycle is fully resolved.
   - **Chunk 6 (landed 2026-05-16):** Real `priming-roll` handler replaces the Chunk 3 no-op stub at `lib/wrap-steps/priming-roll.js`. Pure server-side filesystem reads + a staged (deferred) write — no AI handoff. **Plan format:** the handler parses `### Chunk N: Title` headings; `✅` anywhere on the heading line marks that chunk done; ids tolerate dotted / lettered sub-chunk numbering (`1`, `2a`, `10c.2`, `12.3a.4`). The "current" chunk is the first un-done heading in document order; "next" is whatever follows it. **Blocker annotations:** the first `**Blocked on:** <text>` line within a chunk body (case-insensitive) is captured and surfaced inline on the rolled pointer so the next session sees blockers without re-reading the plan. **Plan path resolution:** `step.planPath` (project-relative or absolute) wins when set; otherwise the handler scans `<project>/.claude/plans/*.md` and requires exactly one match — zero or two+ → `{ok:false, status:'blocked'}` with a "set step.planPath to disambiguate" message. **Priming-file managed block:** the handler edits a region of `.claude/priming/build-session.md` (overridable via `step.primingPath`) delimited by `<!-- TANGLECLAW:PRIMING-ROLL:BEGIN -->` / `<!-- TANGLECLAW:PRIMING-ROLL:END -->`. The rest of the file is sacrosanct — user-authored surround is preserved byte-for-byte; when the markers don't exist yet, the handler appends a fresh managed block separated by a blank line. **Single-transaction discipline (matches Chunk 5):** the handler does NOT touch the filesystem itself; it stages `context.staged[step.id] = {primingPath, newContent, changed, pointer, planPath}`, and the Chunk 9 `commit` step is the only step that flushes staged writes to the working tree. A re-run on an unchanged plan produces an unchanged `newContent` and reports `output.changed === false`; the `commit` step is expected to skip writes when `changed === false`. **Module exports:** six pure helpers (`_parseChunks`, `_selectPointer`, `_renderPointerBody`, `_replaceManagedBlock`, `_resolvePlanPath`, `_resolvePrimingPath`) plus the marker constants — pinned for unit-testability and for the Chunk 9 commit-step contract.
   - **Chunk 7 (landed 2026-05-16):** Real `critic-check` handler replaces the Chunk 3 no-op stub at `lib/wrap-steps/critic-check.js`. Heuristic on session history: medium+ trips when commit count ≥ `step.commitThreshold` (default 10), total line changes ≥ `step.lineChangeThreshold` (default 500), or a chunk-tag pattern (`\bchunk[\s\-_]?N(?:\.N[a-z]?)*\b`, case-insensitive) appears in the current branch name or any commit subject. **Session range** uses `git symbolic-ref refs/remotes/origin/HEAD` → main branch; range spec `<main>..HEAD`. Fallback: `HEAD~10..HEAD` when the symref is missing, current branch is the main branch (work-directly-on-main case), or HEAD is detached — the degradation is surfaced in `output.rangeDegraded` + `output.rangeDegradedReason` so the Chunk 10 UI can warn the heuristic is operating in degraded mode. Chunk 9 will replace this with a `lastWrapSha`-stamped range once the `commit` step starts recording it. **Critic-dispatch detection** reads `<project>/.tangleclaw/critic-runs.json` — an array of `{branchName: string, timestamp: ISO 8601, ...}` entries — and filters to entries whose `branchName` matches the current branch. Any match → `criticRan: true`. Missing file / malformed JSON / non-array / no current-branch entries → `criticRan: false`. **The producer is intentionally NOT shipped in Chunk 7**: the `invoke-critic` action button in methodology templates (`actions[]`) currently has no implementation, and the frontend wiring lives in Chunk 10. Chunk 7 ships only the read contract so the pipeline can produce meaningful output today via test fixtures, and the write side can land in any later chunk without re-touching this handler. **Output shape:** `{warning, isMediumPlus, criticRan, branch, mainBranch, rangeSpec, rangeDegraded, rangeDegradedReason, heuristic: {commits, lineChanges, insertions, deletions, chunkTag, chunkTagSource, chunkTagMatch, commitThreshold, lineChangeThreshold}, criticRunsRecent, owedRationale}`. **Blocker contract: always `false`** — the spec says missing-Critic is a methodology rule the user can knowingly skip with rationale, not a structural failure. The handler always returns `ok:true`; the warning lives in `output.warning`. Even on a misconfigured project (missing `context.project.path`) the handler returns `{ok:true, status:'skipped'}` to honor the never-blocks contract. **Rationale staging.** When `warning === true` AND `options.criticSkipRationale` is a non-empty trimmed string, the rationale is staged at `context.staged[step.id] = {warning, owedRationale, branchName, isMediumPlus, criticRan, heuristic}` for the Chunk 9 `commit` step + Chunk 5 `memory-update` prompt to consume. Whitespace-only rationale is treated as no rationale (owedRationale → `null`). No warning → nothing staged. **Single-transaction discipline (matches Chunks 5 + 6):** the handler reads only — it never writes git, never writes the filesystem; staging is the sole side effect. **Scope discipline:** the bundled prawduct template is intentionally NOT extended with `{kind: "critic-check"}` in this chunk — that would change the legacy `wrapV2:false` NL-prompt path's byte-equal behavior (matches the strict scope policy from Chunks 4 / 5 / 6, where the bundled template was untouched). Methodology authors can opt their template in; a future chunk (likely paired with the Chunk-11 default flip) will wire prawduct's pipeline to include `critic-check` as part of the methodology-and-UI rollout.
   - **Chunk 8 (landed 2026-05-17):** Real `pr-check` handler replaces the Chunk 3 no-op stub at `lib/wrap-steps/pr-check.js`. Reads open authored PRs via `gh pr list --state open --author @me --json number,title,headRefName,baseRefName,url,createdAt,isDraft,author`; partitions into `sessionScoped` (PRs whose `headRefName === currentBranch`) and `otherOpen` so the Chunk 10 UI can render two distinct buckets. **`gh` availability gate:** `gh --version` (no auth, no network) — missing → `{ok:true, status:'skipped', output:{reason:'gh CLI not available'}}`. **`gh pr list` failure modes** (no auth, non-GitHub remote, API hiccup, malformed JSON, non-array JSON) all degrade to `{ok:true, status:'skipped'}` with the first 200 chars of `stderr`/`stdout` surfaced in `output.detail` so the UI can render the recovery hint inline. **Draft filtering:** `step.includeDrafts` defaults `false`; drafts are hidden by default. The unfiltered count is surfaced in `output.counts.rawTotal` so the UI can show a "N drafts hidden" hint without re-calling gh. **Resolution staging.** `options.prHandling` accepts two shapes — a string shortcut (`'merge'|'defer'|'ignore'` applied to every session-scoped PR) or a per-PR object map (`{prNumber: 'merge'|'defer'|'ignore'}`). Both string and number keys are normalized to string before lookup. Invalid keys (PR not session-scoped) and invalid values (handling not in the enum) are surfaced via `output.invalidHandling[]` rather than silently dropped — the UI prompts the user to fix and re-submit. **Single-transaction discipline (matches Chunks 5–7):** the handler reads only — never mutates git, never writes the filesystem. `context.staged[step.id] = {branch, sessionScoped, resolutions, invalidHandling}` only when `sessionScoped.length > 0 || resolutions has entries` (no PRs + no resolutions = nothing for the commit step to do). **Blocker contract: always `ok:true`** — every git/gh probe is wrapped in an outer `try/catch` per the Chunk 7 always-ok pattern; thrown probes degrade to skipped. **Session-scope filter is intentionally minimal:** `headRefName === currentBranch` is the single source of truth — more elaborate matching (PR title chunk-tag, issue cross-reference) is Chunk-10 UI territory. **Scope discipline:** bundled prawduct template intentionally NOT extended with `{kind: "pr-check"}` (matches Chunks 4 / 5 / 6 / 7's strict pattern — would change the legacy NL-prompt byte-equal pin); a future chunk paired with the Chunk-11 default flip will wire it in.
   - **Chunk 9 (landed 2026-05-18):** Real `commit` handler replaces the Chunk 3 no-op stub at `lib/wrap-steps/commit.js`. The load-bearing single-transaction flush point — every prior step that staged a write or commit-message ingredient lands here. **Four-phase orchestration:** (1) flush staged filesystem writes — duck-typed on shape `{primingPath, newContent, changed}` so today's only producer (priming-roll) and any future write-producing step that mimics the shape Just Works without a dispatch-table edit; `changed === false` is treated as no-op so idempotent re-wraps stay write-free, missing `changed` defaults to "needs write" (defensive); (2) detect "anything to commit?" via `git status --porcelain` — empty output → `{ok:true, status:'skipped', output:{reason:'no changes to commit', commitSha:null}}`, the runner threads the null SHA up and `lastWrapSha` is NOT stamped on a clean session; (3) `git add -A` + `git commit -m <session-derived message>` — the user pressing Wrap is opting into "everything in my working tree belongs to this session" (Chunk 10's UI will surface the file list so the user can cancel before this step runs); (4) `git rev-parse HEAD` captures the commit SHA, then `_stampLastWrapSha(project.path, sha)` writes `projConfig.lastWrapSha = sha` via the file-based `projectConfig.load`/`.save` round-trip. **Blocker contract: real `blocker:true`** (not always-ok). Unlike Chunks 5–8 which were always-ok with outer try/catch, this step is the load-bearing transactional gate — `git status` failure, `git add` failure, or `git commit` failure (typically a pre-commit hook rejection) → `{ok:false, status:'blocked', blockers:[...]}` and the runner halts. The git/hook output (`stderr` first, falling back to `stdout`, trimmed) is surfaced verbatim in `blockers[]` so the user sees what to fix. Per CLAUDE.md's Git Safety Protocol we do NOT pass `--no-verify` — the pre-commit hook is the user's intentional gate. **Commit message strategy: `session-content`.** Subject derived from a chunk-tag regex on the current branch (`chunk-9-…` → `Session wrap (chunk 9)`; dotted/lettered ids like `chunk-10c.2` are honored to match the priming-roll / critic-check chunk-id grammar) with a branch-name fallback (`Session wrap on feat/some-feature`) and a generic fallback for detached HEAD (`Session wrap`). Body assembled from shape-typed staged entries via `_buildBodyLines`: priming-roll's `pointer.current` → `- Priming rolled to Chunk N — Title` (with `(blocked on: …)` on a follow-up line when present), ai-content's `capturedText` → `- AI content (<step-id>): captured` or `- AI content (<step-id>): captured fields [a, b, c]` if `parsedFields` is non-empty, critic-check's `owedRationale` → `- Critic skip rationale: <text>` (or warning-without-rationale form when warning fired without a rationale), pr-check's `sessionScoped` + `resolutions` → `- Open session-scoped PRs: N` + `  - PR #<num>: merge|defer|ignore` per resolution. Subject capped at `MAX_SUBJECT_LEN = 72` chars with `…` truncation marker. Anything not matching a known shape is silently skipped — extra staging keys aren't an error. **`lastWrapSha` stamping is non-fatal on failure.** The commit already landed; the stamp is a hint for later steps' range detection. `_stampLastWrapSha` returns `boolean` and `log.warn`s on failure; the outcome surfaces on `output.stamped` so the Chunk 10 UI can render "stamp failed" inline rather than producing a runner-level blocker. Once enough wraps have stamped on a project, Chunks 4 (lint scope) and 7 (critic-check range detection) can drop their `HEAD~10..HEAD` fallback in favor of `<lastWrapSha>..HEAD` — that wiring lands in a future chunk; Chunk 9 just makes the stamp available. **Runner threading:** `lib/wrap-pipeline.js:runWrapPipeline` now reads `commitSha` from any step result whose `output.commitSha` is a non-empty string and populates the top-level `result.commitSha`. The threading is step-id-agnostic (first-wins on a populated `output.commitSha`) so a future methodology with a renamed commit step still surfaces the SHA without a runner edit. Halted pipelines and clean-session skips leave `result.commitSha = null`. **`projConfig.lastWrapSha` field:** added to `DEFAULT_PROJECT_CONFIG` (defaults `null`); round-trips through `projectConfigApi.load`/`.save` and merges with on-disk configs that pre-date this field via the existing deep-merge loop in `projectConfigApi.load`. **Bundled-template change (first chunk to touch `wrap_pipeline` schema since Chunk 2):** `data/templates/prawduct/template.json` and `data/templates/minimal/template.json` each declare `"blocker": true` on their commit step. (`data/templates/tilt/template.json` carries the same change locally but is gitignored, so it does not ride along in this PR — the matching tilt-blocker test in `test/wrap-pipeline.test.js` is gracefully skipped when the file is absent.) The back-compat shim (`lib/skills.js:wrapShapeFromTemplate`) reads only `step.id` and `step.captureFields[]`, so adding `blocker` to an existing step does NOT change the legacy `wrapV2:false` NL-prompt path's byte-equal output — the regression pin in `test/sessions.test.js` continues to pass. The choice to declare it in the template (vs. an implicit "commit kind is implicitly blocker:true" rule in the runner) keeps the runner shape-dumb and the methodology template the single source of truth. **Test-scaffolding pollution fix:** several Chunk-3-era tests ran the full pipeline against tmp-dir projects that aren't git repos — they passed in Chunks 3–8 because every step was either a stub or always-ok. Now that `commit` is a real blocker handler, those tests would hit `git status` failure and return `ok:false`. The affected tests in `test/wrap-pipeline.test.js` and `test/sessions.test.js` now monkey-patch `STEP_DISPATCH['commit']` to the canonical no-op for the duration of their assertion (with `finally`-block restore), keeping each test focused on what it actually asserts. The Chunk-9 commit-handler tests stand up real git repos via `execSync('git init ...')` in `beforeEach`.
   - **Chunk 10 (landed 2026-05-18):** Frontend multi-step wrap progress drawer + options-threading wire-up from request body → runner. New `public/wrap-drawer.js` exposes DOM-free helpers (`buildStepRow`, `summarizePipelineStatus`, `decisionWidgetForBlockedStep`, `warningWidgetForStep`, `prCheckResolutionWidget`, `collectOptionsFromAccessors`, `deriveDetail`) consumed by `public/session.js`; mirrors `public/api-helper.js`'s factory pattern so the logic is vm-sandbox testable in pure Node. **Runner-API surface:** `lib/sessions.js:triggerWrap(projectName, options)` gains an `options` second arg (V2-only — ignored on the legacy NL-prompt path so existing call sites stay back-compat); `_triggerWrapV2` passes through to `wrapPipeline.runWrapPipeline(name, options)`. The runner already accepted `options = {}` since Chunk 4; Chunk 10 closes the loop from the HTTP boundary to the runner. **`POST /api/sessions/:project/wrap` body contract:** `{password?, options?}` — `options` is object-only (arrays / strings / numbers / null all coerce to `undefined` so the runner's default-param governs). Response gains `pipelineResult` on V2 paths (still absent on V1 to preserve byte-equal back-compat). **HTTP semantics on blocked pipeline: `200 OK` with `status:'blocked'` (NOT `500`).** A blocked pipeline is an expected outcome that the drawer renders — the runner produced a structured result, the endpoint returns it. `500` is reserved for the runner throwing (no `pipelineResult` present); `404` still for missing project / session; `403` still for password-required-but-missing/wrong. **Decision-widget contract — three kinds, one collection path.** (1) `test` blocked (`blocker:true` + `allowOverride:true`) → checkbox → `options.skipTests:true` on retry. (2) `critic-check` warning (`blocker:false` step with `output.warning === true`) → textarea → `options.criticSkipRationale:<trimmed text>` on retry (whitespace-only text is dropped so the gate can't be bypassed with spaces). (3) `pr-check` unresolved session-scoped PRs (`output.sessionScoped.length > 0` and not in `output.resolutions`) → per-PR `<select>` (`merge` / `defer` / `ignore`) → `options.prHandling: {[String(prNumber)]: <enum>}` on retry (key type is `string` to match the runner's `_normalizeHandling` `String(key)` lookup; both string-shortcut and per-PR-map shapes accepted by the runner). `lint` blocked and `commit` blocked intentionally have NO recovery widget — the user fixes outside the drawer (lint errors → edit code; pre-commit hook rejection → fix the hook-rejected issue) and clicks Retry. `decisionWidgetForBlockedStep` returns `null` for these kinds; the drawer still surfaces blockers inline. **Action-button contract.** Retry visible whenever there's something actionable (blocker OR an unresolved widget). Done visible on clean ok:true AND on warning-only state (the latter lets the user accept warnings as-is without producing a second commit — see "Re-run trade-off" below). Cancel/Close always present. **Re-run trade-off (warning state).** Because `critic-check` is `blocker:false` and `pr-check` is `blocker:false`, the pipeline runs through to `commit` even on the first run when those steps emit warnings or have unresolved entries. A retry-with-options re-runs the whole pipeline and produces a SECOND commit on top of the first. The drawer's inline note in the pr-check resolution widget surfaces this so the user can choose Done (accept current state) over Retry (re-run with options + second commit). Pausing the pipeline *before* commit on warning state is structurally out of scope for Chunk 10 (would require runner-side state machine + resumption) and is tracked as a follow-up. **Password replay on retry.** The wrap endpoint enforces `deleteProtected` on every call (V1 and V2 alike); the drawer caches the password collected by the initial confirm modal and includes it on retry so delete-protected installs don't re-prompt. Cleared on drawer close. **No live progress updates (deferred).** TangleClaw has no WebSocket / SSE infrastructure today (only ttyd's terminal proxy). The pipeline runs synchronously inside the HTTP request; the drawer renders the final state, not in-progress. The build plan's "WebSocket or SSE for live status updates" is deferred to a separate chunk (file as a follow-up issue when scheduled). The drawer's `--running` status tone is reserved in CSS for the eventual live-progress phase but unreachable today. **Scope discipline:** the bundled prawduct / minimal / tilt templates are NOT modified in this chunk — adding pipeline-default steps (e.g. wiring `critic-check` into prawduct) would change the legacy `wrapV2:false` NL-prompt byte-equal pin; that wiring lands paired with the Chunk-11 default flip.
4. **Chunk 11 (split into 11a / 11b / 11c during the 11a session-start scope review, 2026-05-19):** the original Chunk 11 — "flip the default + fold in lifecycle / prawduct wiring / invoke-critic producer" — needs the pre-flip plumbing to land first so V2 is a quality experience when the flag flips. Split:
   - **Chunk 11a:** V2 session-lifecycle transition — `_triggerWrapV2` calls `store.sessions.wrap(active.id, summary)` + teardown (kill tmux, release doc locks, clear idle + wrap-pane caches) on `pipelineResult.ok && pipelineResult.commitSha`. Halted / thrown / clean-session paths leave the session active per spec. Summary string synthesized from the pipeline result. Pure addition to the V2 path; no legacy-path effects, so it's safe to ship pre-flip.
   - **Chunk 11b:** `invoke-critic` action producer — wires the prawduct `invoke-critic` action button (currently no-op) so clicking "Run Critic" writes an entry to `.tangleclaw/critic-runs.json` per Chunk 7's read contract. Without this, `critic-check` always emits `warning: true` post-flip because there's no producer for the read side.
   - **Chunk 11c (landed 2026-05-19):** Default flip. `DEFAULT_PROJECT_CONFIG.wrapV2: false → true` at `lib/store.js`; brand-new projects and projects whose on-disk `.tangleclaw/project.json` predates the field both pick up the V2 path. Existing projects with an explicit `wrapV2: false` in their on-disk config keep the legacy path — `projectConfigApi.load`'s deep-merge preserves the override. Prawduct's bundled `wrap_pipeline.steps` is extended with `open-pr-check` (kind `pr-check`) and `critic-check` (kind `critic-check`), both `blocker: false`. The shim at `lib/skills.js:wrapShapeFromTemplate` flattens every `step.id` into the legacy `steps` array, so this template change also alters the legacy NL prompt's `Wrap steps: …` join — intentional, and both byte-equal regression pins (`test/sessions.test.js` and `test/skills.test.js`) are updated to reflect the post-Chunk-11c step list. Two `wrapV2`-related tests get their semantics inverted to match the new default: the absent-flag test now asserts V2-routing instead of legacy fallback; the explicit-`wrapV2:false` test is renamed to "explicit opt-out" and pinned against the new step list. **Migration path documented:** README adds a `Session Wrap (V2 default, opt-out path)` section with the per-project `wrapV2: false` recipe; this ADR's Status line carries the Chunk-11c marker. **Post-flip behavior of the V2 path is fully covered by Chunks 11a + 11b:** session lifecycle ends correctly (11a — `store.sessions.wrap` + teardown); `critic-check` warns are clearable via the in-banner `Run Critic` button which writes the file `critic-check` reads (11b). **Legacy code stays one release:** `triggerWrap`'s legacy NL-prompt branch remains executable behind `wrapV2: false`; a follow-up release strips it along with the back-compat shim in `lib/skills.js:wrapShapeFromTemplate`.
5. **Post-#139 follow-up release:** Delete the legacy `wrap`-block branch from `wrapShapeFromTemplate`. Remove inert `wrap.steps` / `wrap.captureFields` reconciler entries from `ARRAY_RECONCILERS`. Delete the legacy NL-prompt code from `triggerWrap`. Schema migration complete.

This ADR is the durable home for the architectural pattern. The self-deleting auto-memory `project-issue-139-methodology-wrap.md` retires once #139 closes; this file persists.


---

## Extended 2026-07-20 — the methodology layer is gone (#538, second half)

The first half of #538 moved the pipeline *declaration* from template data into
`lib/wrap-default-pipeline.js`. This half deletes the layer that used to hold it: the
methodology registry, the bundled templates, the template store and its reconcile/fork
machinery, the `methodology` project field and DB column, and the chooser/phase/switch UI.

**What this changes about the contract above.** Every sentence in this ADR that speaks of "a
methodology template declares", "methodology authors", or "forking a methodology id" describes
a mechanism that no longer exists. The contract itself survives intact — the runner, the step
kinds, the blocker semantics, the single-transaction commit flush, the staged-write discipline
— but its *source* is code, and its per-project surface is exactly `wrapStepOverrides` plus
the dedicated effect toggles. There is no fork path, no `schemaRevision` ratchet, and no way
for a project's step list to diverge from the one in the repository.

**What that buys.** The propagation gap the ratchet existed to close cannot reopen: a step-order
fix used to reach an already-onboarded install only through a `FRAMEWORK_OWNED_PATHS` subtree
sync gated on a manually-bumped revision, so shipping the fix without the bump left every
existing project running the old order while the bundled JSON and its tests stayed green. Code
cannot lag that way.

**Governance moved with it.** `governanceState()` no longer keys on a project's methodology
label; it reports what is installed on disk — `governed-plugin`, `governed-vendored`,
`ungoverned`, or `not-applicable` for a non-Claude engine. The `drift-no-governance` state is
deliberately gone: it detected a *contradiction* between a project's claimed methodology and
its actual enforcement, and with no claim left to contradict, "not governed" is an ordinary
condition rather than a fault. The Run Critic action re-keys on `governed-plugin` for the same
reason — the plugin is what ships the Critic, so availability follows the install, not a label.

## Extended 2026-09-14 — the AI release recommendation (#1492 L2)

`version-bump`'s readiness verdict (`lib/release-readiness.js`) reads files. It can't tell a
wrap the operator means to release from one that saves state before they leave. A new content
step, `release-recommendation`, runs between `changelog-update` and `version-bump`. It asks the
session for `cut`, `hold` or `unsure`, the operator's own words about the wrap, and a reason.
`version-bump` reads the answer from the prior results
(`lib/wrap-steps/_release-recommendation.js`).

**Neither signal overrules the other.** In `auto`, agreement keeps the verdict's outcome, and
so does an `unsure` or missing recommendation. A disagreement halts with `needs-operator` and
`disagreement: true`, and the drawer shows both sides. The recommendation can stop an automatic
cut or hold, but it can never make one. The verdict is deterministic but blind to intent; the
recommendation sees intent but is a model's reading. So `wrap-direction.md` commitment 2 still
holds: the same inputs produce the same release on every engine, and a model can only turn a
release into a question. In `ask` the recommendation is a hint in the halt's reason.

**The conversation is read by the session that holds it.** The prompt goes into the live
session, and the AI quotes the operator from its own context. The server doesn't scrape a
transcript: `lib/transcript.js` resolves Claude Code's files only, so a scraped transcript would
make the recommendation a one-engine feature. A session that has been cleared since the
operator spoke writes `none stated`, and the recommendation rests on the work.

**The prompt doesn't carry the verdict.** An AI shown the verdict tends to agree with it, and
the disagreement check would then never fire.

**Non-blocking by design.** The step is `blocker: false`. A recommendation that never arrives
leaves the verdict to decide alone, which is exactly the behaviour before this step existed. A
closed `precondition` sends no prompt when `releaseMode` is `off`, when the operator has already
chosen Cut, Hold or a level, or when `[Unreleased]` has no entries.


## Extended 2026-09-15 — a project's release-prepare command (#1502)

A release can need files the wrap knows nothing about. TangleClaw's own releases need the README
clone pins and a lock of released CHANGELOG sections, and the first wrap-cut release failed CI
without them (#1501). Teaching `version-bump` those files would make one repo's conventions every
project's behaviour. Instead a project names a `releasePrepareCommand`, and the wrap runs it.

**It runs in `commit`, not `version-bump`.** `version-bump` stages and never writes, and the command
needs the promoted CHANGELOG on disk. So `commit` runs it right after `_flushStagedWrites`, and only
when the staged entries carry a release (`oldVersion` / `newVersion`). The release reaches it as
`TANGLECLAW_RELEASE_VERSION` and `TANGLECLAW_RELEASE_PREVIOUS`, never interpolated into the shell
string.

**What it changed is measured, not declared.** `git status` plus a content hash of every uncommitted
path, before and after, gives the paths it touched, including a file that was already uncommitted
(the flushed CHANGELOG). Those paths join the wrap-written set, so the #1406 ownership rules apply
unchanged and an operator's Leave still holds.

**A failure puts the release back.** This is an exception to the rule that a halted `commit` leaves
flushed writes on disk. Without it a Retry would find `[Unreleased]` empty, `version-bump` would skip,
and the commit would land the bump without the files the command was there to add, which is the red
PR this exists to prevent. The pre-flush contents of every staged target are captured before the
flush and restored on a non-zero exit or a timeout, and the result is `blocked` with the command's
output. Files the command itself changed before failing are named in the remediation, not reverted:
they were never snapshotted. A command that succeeds followed by a later `commit` failure is not
rolled back either. The companions are then uncommitted session changes, and the Retry commits them.

**Engine-agnostic.** A shell command and git: the same inputs produce the same commit on every engine.


## Extended 2026-09-20 — exactly one release authority per release-governed group (#1697)

**Status: ACCEPTED** — ratified by the Architect 2026-09-20 at head `683ae8096`, after one
revision round against the review on PR #1703. Drafted by Builder1; the Architect approves ADRs.
Nothing is built yet: this records the decision so the build implements a ratified rule rather than
inventing one. Implemented by #1697.

`releaseMode` is per project, and nothing relates one project's mode to another's. A fleet whose
members share a repository can hold several release-capable projects at once, and nothing says so.
On 2026-09-20 three members of this install's own group — `TangleClaw-Builder1`,
`TangleClaw-ProjectManager` and `TangleClaw-Builder2` — were simultaneously release-capable. The
condition had existed for an unknown period and surfaced only because a check was written and run by
hand.

**The operator's requirement, stated 2026-09-20:** *"once a system is put together with multiple
team members, there can only be one that has that ability. All the other ones must be set to off for
the system to work … the system has to force this working condition."*

### The invariant is binary, not graduated

`off` is the only value under which the step does not run (`lib/wrap-steps/version-bump.js` returns
`skip`). Every other value means it executes and may cut. `ask` reads as safe because a human must
choose Cut, but that governs *when* a cut happens, not *whether* the project can make one. Two
members on `ask` are two members that can each author a bump. So the condition is exact: **exactly
one member release-capable, every other member `off`.**

### Release governance is opt-in, never implied by a group

`project_groups` today relates projects for shared documents and infrastructure, and may contain
repositories with entirely independent release streams. Governance therefore attaches to a
**release-governed group**, marked explicitly — a nullable owner field is a sufficient opt-in.

- A group with no release governance has **no effect on releases**. It must never suppress one.
- An **ungrouped project keeps today's per-project behaviour** unchanged. A solo project must not
  have to form a group to cut a release.

### At most one release-governed group per project, and ambiguity fails closed

`project_group_members` is keyed `PRIMARY KEY (group_id, project_id)`, so only the pair is unique: a
project may belong to several groups, and `test/engines.test.js` exercises that directly. A project
may therefore belong to **at most one release-governed group**, enforced on mutation.

Where legacy or corrupt state produces more than one, **runtime fails closed**, naming every
conflicting group and owner. It must never select the first group the store returns — an arbitrary
pick is the silent-wrong-answer class this ADR's 2026-09-14 entry exists to refuse.

### The ownership lifecycle is defined, and every transition is atomic

- The owner is a **current, non-archived member**, enforced by constraint and by transactional
  validation — not by convention.
- **Enabling** release governance assigns an owner atomically. **Transfer** is one atomic operation.
- **Rejected until authority is atomically transferred, or governance explicitly dissolved:**
  removing or archiving the owner, hard-deleting the owner, and deleting or dissolving a
  release-governed group.
- A normal group may have no owner. A group already marked release-governed **may not silently
  drift to zero owners**.

### Effective capability is the group's, and the owner's local mode is only a policy

The group record is the source of truth for **who may release**.

- A **non-owner's effective mode is forced to `off`**, whatever a stale or hand-edited local value
  says, and write paths **reject** attempts to make a non-owner release-capable.
- The **owner's local mode selects only the decision policy** — whether the agent or the operator
  decides. (Stated semantically so the mode naming in #1701 remains a separate decision.)
- If the owner's local mode is `off`, unreadable, or otherwise unusable, **runtime skips with an
  explicit remediation** rather than choosing a policy on the operator's behalf.

### One resolver, consumed at every surface

A single shared release-capability resolver serves `release-recommendation`, `version-bump`, the
settings/API projection, and write validation. `release-recommendation` must consume it too, so a
non-owner is never prompted for a release decision it could not execute — displayed, writable,
prompted and executable state cannot be allowed to disagree. **`version-bump` remains the
load-bearing backstop**, because it is the last surface before the act itself.

### A non-owner skips; it does not error

The refusal takes the existing `skip` shape and names the owning project, so the wrap continues, the
changelog entry is still written, and the only thing withheld is the promotion and the bump — which
were never this member's to make. That is ADR 0013's contract applied here: a setting that does not
take effect says why it does not. It also keeps the 2026-07-19 entry's distinction intact —
never-blocks governs the pipeline, and a refusal to act on an input the step cannot honour is not a
block.

### Why write-time enforcement alone is insufficient

`version-bump` resolves its mode from `store.projectConfig.load(...)` — the member's own
`.tangleclaw/project.json`. **In this checkout that file is ignored (`.gitignore:66`) and untracked,
so an ordinary branch switch does not restore it**, and an earlier draft of this amendment was wrong
to say otherwise. The runtime check is still load-bearing, for the cases that do occur:

- an agent or operator edits the file directly;
- a newly attached project arrives on the installed default, which is how the three owners above
  appeared;
- a hand-typed invalid value resolves to `ask` (`lib/project-config.js`), not `off` — an
  unrecognised mode is release-capable;
- stash or restore paths that explicitly include ignored files;
- legacy repositories where the file is **tracked**, where checkout does rewrite it.

Guarding only the API guards the one path that was never the problem.

### Acceptance shape

The contract is ratifiable when these states are mechanical: an ordinary group has no effect on
releases; a release-governed group has exactly one active-member owner; only that owner can be
effectively non-`off`; ownership transitions are atomic; ambiguous or invalid runtime state skips
safely with an actionable reason; and the recommendation prompt follows the same capability decision
as the bump step.

### Out of scope, deliberately

The default for an absent `releaseMode` (#1702) and the naming of the modes (#1701) are separate
decisions and are not settled here. Whether release authority is ultimately an attribute of an agent
*role* rather than a field on a group is Train 22's to decide; this amendment asks only that the
build not make that migration expensive. ADR 0002's overgrown amendment ledger deserves a
current-contract index, which is its own issue and not this revision's business.


## Amended 2026-09-16 — a finished wrap ends the session, commit or not (#1558)

Chunk 11a ended the session only on `pipelineResult.ok && pipelineResult.commitSha`, and treated a
finished run with nothing to commit as a no-op that leaves the session active. That no longer holds.
A project that ships its work by pull request before the wrap has nothing left to commit, and on a
clone that ignores `.tangleclaw/` the wrap's own writes aren't committable either. So a full wrap
reported `no changes to commit` and the session stayed open after the operator pressed Wrap to finish.

**The rule is now: a run that finishes (`ok`) ends the session**, with the same teardown as before
(record the wrap, kill tmux, release doc locks, clear caches), whether or not it committed.
Stopped (`needs-operator`, blocked), failed and thrown runs still leave the session active, because
those are the runs where the terminal is still needed.

**The operator can keep the session** with `options.keepSessionRunning: true`, chosen in the wrap
dialog before the run and replayed on Retry. It is validated before a run is claimed: anything but a
boolean is refused, so a malformed value can't end a session the operator meant to keep.

> **Superseded in part (2026-09-23, #1708):** the request option is no longer the only input to
> keep/end, and a run can now end `cancelled`. See "Amended 2026-09-23: wrap intent and honest
> cancellation" below. The rest of this amendment stands.

**The result says what happened to the session.** `sessionOutcome` on the run's result payload is
`ended`, `kept`, or `null`. It is not a boolean because a session killed during the wrap is neither
ended by the wrap nor still running.

**Alternative rejected:** asking "Kill session?" after a no-commit wrap. The answer is almost always
yes, and the question would have left the wrong server rule in place for every other client.

**Engine-agnostic.** The rule reads only the pipeline's `ok` and the request's option, so every
engine gets the same lifecycle.

## Amended 2026-09-23 — wrap intent and honest cancellation (#1708, #1707)

This amendment supersedes the 2026-09-16 statement that the request option alone selects keep/end.
It records Architect rulings D1–D5 for Train A Car A3 Chunk 01. Provenance is #1707 and #1708.
Switchboard message 417454d7 is review evidence only, not the authority. It adds no design
decision beyond those rulings.

1. **Keep intent is resolved server-side exactly once, before the run is claimed.** The value comes
   from the first of these that applies:
   - an explicitly present boolean request value;
   - a valid boolean `wrapKeepSessionRunning` in the project config;
   - `false`, when the key or the config is genuinely absent.

   A persisted config that is unreadable, malformed or invalid refuses the wrap before the claim.
   Caller-supplied `keepSource` and planned-outcome fields are ignored. The immutable resolved
   value and its source feed the registry, the handoff kind, the lifecycle and Retry. A Retry keeps
   the trusted provenance unless a new explicit boolean changes it.
2. **The planned outcome is stated before any step moves.** The 202, the status payload and the
   `run-start` event carry `sessionOutcomePlanned` (`end`|`keep`) and `keepSource`. Operator copy is
   conditional ("If this wrap completes…"), because blocked, failed and cancelled runs remain active.
3. **Cancel route.** `POST /api/sessions/:project/wrap/cancel` is bound to the exact `runId`, behind
   the same authority boundary as starting a wrap.
   - Cancel admission and step start are one atomic registry transition.
   - Repeated requests against a live run are idempotent.
   - A cancel is accepted only before `commit` starts.
   - The running step finishes. There is no mid-step interrupt, no post-commit revert, and no
     cancellation after the durable cutoff.
4. **What an accepted cancellation guarantees.** No subsequent commit, branch, push, PR, auto-merge
   or later durable Git action. It does not promise an untouched working tree. It does not undo
   earlier local methodology, DB, prompt or uncommitted file effects. The completed steps and the
   possible local side effects are reported.
5. **Cancellation is a distinct outcome.**
   - Shape: `ok: false`, `outcome: 'cancelled'`, `blockedAt: null`, `error: null`, and
     `cancelledAt` naming the first step that had not started. Later rows are `pending`.
   - The session stays active, and neither Retry nor Skip is offered.
   - If the finishing step blocks after a cancel was accepted, its result stays visible, but the
     cancellation is terminal.
6. **Operator controls.**
   - **Hide** only hides the panel and keeps following the same run.
   - **Cancel** appears only while the run is cancellable. After acceptance it says the current
     step is finishing.
   - After the cutoff it states that cancellation is no longer possible and shows the actual
     current step, rather than permanently saying "committing".

**Engine-agnostic.** Resolution reads the request and the project config. Cancellation reads the
run registry and the pipeline's step order. No engine capability is involved.

## Amended 2026-09-23 — wrap gates are engine-aware and never read as passed (#1738)

This amendment records the Architect's rulings E1–E6 for Train A Car A3 Chunk 02. They apply the
Architect's 2026-09-21 ruling on #1738, and the provenance is #1738. The Operator approved the
matching amendment to project rule #5 on 2026-09-23. Switchboard messages 9a774624 (rulings) and
8af0c8ec (the approval, relayed by the Project Manager) are review evidence only, not the
authority. This amendment adds no design decision beyond those rulings.

1. **One capability resolution per run (E1).** The run resolves, once and immutably, whether the
   **session's** engine can run the project's methodology. An unknown engine fails to
   `capability-unavailable`. Any `.prawduct/` directory, or the committed plugin reference, is a
   conservative dormant-state signal, not proof of healthy onboarding. Every step reads that one
   value.
2. **Two first-class statuses (E2).** `not-applicable` means the step has no subject: the project
   carries no onboarding signal. `capability-unavailable` means it applies, but this engine cannot
   perform it, so its evidence was not produced. Neither halts the run. Every consumer fails closed
   on a status it does not know.
3. **A required gate that produced no measurement is unmeasured (E3).** The one
   provider-specific required gate is `preflight`. On an engine that can run the methodology, any
   preflight that produced no measurement degrades the handoff. That covers a missing hook, a
   timeout, a contract breach, a "Wrap anyway" after a failure, and a configured step override. An
   Operator override may permit the state-only checkpoint. It cannot turn absent evidence into
   complete.
4. **A dormant methodology withholds its own effects; the checkpoint finishes (E4).** The
   checkpoint and the neutral publication finish. The following are withheld:
   - the release cut and the ledger stamp;
   - arming auto-merge, and merging PRs through PR resolutions;
   - every write to `.prawduct/`.

   The result and the handoff are degraded. Project rule #5 now separates engine-neutral wrap
   mechanics, which are identical across engines, from provider-owned methodology effects, which
   are withheld on an engine without the capability and never faked.
5. **The handoff records the disposition (E5).** The handoff document carries an optional,
   additive `methodology: {disposition, engineId}`. Omission means unknown, an invalid enum value
   fails validation, and a launch never parses the prose in `missingEvidence`.
6. **The return path is advisory (E6).** A launch on a capable engine after a
   `capability-unavailable` publication tells the session to run `/prawduct:doctor` before any
   methodology work, and never to onboard again. It does not gate the launch, and it does not
   claim that Doctor passed or that authority was restored, because TangleClaw cannot observe
   either. The historical handoff disposition stays immutable. Prawduct restores its own authority
   through the owner-confirmed Doctor flow. A later measured preflight on a compatible engine may
   establish a new publication result.

Out of scope, filed as #1809: capability-matched admission, attested engine rotation, and
engine-neutral canonical instructions.


## Amended 2026-09-23 — a new file is admitted by a decision, and the wrap names what it carries (#1724)

Architect ruling, message 5b0eaa0d (F1, F2):

- **F1.** A file new to the repository is not admitted by recency or by `git add`. It needs an
  explicit Include or Leave, including one with index status `A`. The #1406 classifier gives the
  foreign reason `untracked-new` to a path HEAD has never held (porcelain `??`, or index status
  `A`) that first appeared after the launch and that no wrap step wrote. It is asked about through
  the same Include/Leave decision as every foreign path, and blocks `session-files` and `commit`
  until answered. A new file that was already uncommitted at launch, or predates it, keeps that
  more specific reason.
- **F2.** One staged source names the session files and the operator-included files, in both the
  commit body and the PR body. `commit` stages `{sessionFiles, includedFiles}`. The session files
  are the owned paths minus those a wrap step wrote, whose own lines already describe them.

Consequence: a wrap, including an unattended one another session started, stops at
`session-files` when the session leaves any new file uncommitted. A wrap step's own write is
recognised by its resolved path, so a project registered through a symlink is not asked about
the wrap's own output.

Architect ruling G2 (message cdce349b): the files TangleClaw itself writes into a project — the
enumerated engine config carriers and `.tangleclaw/project.json`, never a blanket `.tangleclaw/**`
or filename pattern — are not `untracked-new`. They keep the rules they had, and a carrier's #1619 identity refusal still applies.
The reason's wording names no creator ("being new since this session launched does not show it
belongs in the project"), because a co-resident session's file looks the same.

## Amendment (Train 21, #1585) — the wrap publishes a per-attempt handoff

The pipeline gains a final step, `handoff-stage`, and the lifecycle gains one write.

**A publication belongs to a wrap ATTEMPT, not a session.** Every wrap run mints a new run id, so a
Retry or a resume is a new attempt with its own publication. A kept session therefore publishes
checkpoint, checkpoint, final — each an immutable document. `UNIQUE (session_id, wrap_run_id)` makes
a replayed stage *within one run* return the first attempt rather than mint a second.

**`handoff-stage` runs last and never blocks.** It is placed after `apply-pr-resolutions` because the
document records what the wrap achieved; staged earlier it would describe a wrap that had not
finished happening. A failure is recorded in the run result and the wrap still completes — this is
wrap-direction §3, a gate blocks only where failure would otherwise be silent or destructive, and a
missing handoff is neither. Preflight reports the absent publication later.

**The bytes are frozen at staging.** Publication time lives only in the database, precisely so that
publishing never rewrites the document: an edited document cannot be what its digest attests to. The
digest recorded at staging is therefore the digest of what is published, by construction.

**Eligibility is attempt-exact, and it is bound inside the lifecycle transition.**
`store.sessions.wrap(id, summary, {publicationId, wrapRunId})` performs the `active → wrapped` UPDATE
and the eligibility binding in ONE transaction. If the transition is refused — an operator pressed
Kill and won the race — nothing is bound, and the attempt is abandoned rather than published. A
checkpoint has no lifecycle transition, so `markCheckpointComplete` is its single equivalent write.

**Nothing infers eligibility from session status.** This is the rule the whole design rests on. Take
attempt A, which staged a final and died before its lifecycle completed, and attempt B, which later
wrapped the same session: A's `eligible_at` is NULL, so A is never repaired and never published,
regardless of what B did. Session status would have said "wrapped" for both.

**An attempt that completed but lost the race is superseded, not abandoned.** Abandoning it would
erase the record that it finished. It keeps `eligible_at`, gains `superseded_by`, and never touches
`current.json`.

**A rename is never trusted to prove the database was updated.** Publishing retires the current
document into `history/` and only then renames the new one into place, so a crash between the file
move and the DB write leaves both the old bytes and enough evidence to reconcile. That split is
unavoidable — a filesystem rename cannot join a SQL transaction — and it is the reason
reconciliation exists rather than an oversight.

**`wrapRunId` reaches the step server-side only.** It is set after the request options are spread,
the same guarantee `onStepEvent` and `resumeFrom` already carry, because it is the identity a
publication is bound to and a request body must never be able to name another run.

## Amendment (Train 21, #1586) — the launch path is the second writer

The amendment above says "preflight reports the absent publication later", which was true while
preflight did not exist. It now does, and it does more than report: **`applyHandoffRepairs`, called
from `lib/sessions.js`'s launch path, publishes.** The wrap is no longer the sole writer of
`current.json`, `history/` and `handoff_publications`.

**What the launch path may write, and only this.** It finishes a publication the wrap had already
earned — one whose `eligible_at` was bound in the lifecycle or checkpoint transaction — and which a
crash left half-applied across the rename that cannot join a SQL transaction. It never stages, never
binds eligibility, and never creates an attempt. Every rule above still holds over it unchanged:
nothing infers eligibility from session status, an attempt that completed but lost the race is
superseded rather than abandoned, and a mismatched file is never published.

**Two repairs, because the crash lands in two places.** `publish` promotes a staged file whose rename
never happened. `record-published` records a row whose rename DID happen — the bytes are already
`current.json` and only the database is behind. The second is invisible to a scan of the staged
files, since after the rename no staged file remains, which is why it needs its own action rather
than falling out of the first.

**The repair re-validates; it never trusts the proposal.** Detection is pure (`lib/launch-preflight.js`
writes nothing), so every condition is re-established against the live row and the live file inside
the transaction that acts. A refusal is an outcome, not an exception: a launch must not fail because
a repair could not be applied.

**Ordering on the launch path.** The repair runs before `launchBaseline.capture`, so the file it
moves is not counted as the new session's own change and put in front of the operator at wrap.

## Extended 2026-09-20 — a step may report that its prompt was NOT accepted (#1685)

*Amended in place the same day, by Architect ruling, after the tri-state's positive value proved
unsound. The original wording declared `'accepted' | 'not-accepted' | 'unknown'`; it is replaced
rather than annotated, because a contract readers might still implement must not state a value no
writer may emit.*

A step handler's result may carry two fields beside `{ok, status, output, blockers}`:

```
deliveryOutcome?: 'not-accepted' | 'unknown'
deliveryReason?:  string      // the sentence explaining that outcome
```

**There is no `accepted`, and no current writer may create one.** Four review rounds found four
reachable paths to a false `accepted` — every one of them in the accept half — because the boundary
between a composer and a transcript, read from a bounded capture of a rendered TUI, cannot support a
positive claim: the composer wraps across rows, scrolls its own head out of the capture, and can be
drawn without a prompt glyph. The accept inference also had no independent behavioral consumer; an
`accepted` step fell through to the same wait it would have done anyway.

**Positive evidence is downstream task completion** — the completion marker, the capture file, and
the settle watch — which is where it always was. This receipt is negative-only: it may prove that a
send was not accepted, and otherwise reports `unknown`.

**`not-accepted` must be attributable to THIS send.** Only two things qualify: this send's nonce
still inside a reliably located composer across the confirmation reads, and an engine's declared
rejection marker observed as a post-send event. A marker merely present in bounded scrollback may be
stale. A composer holding some *other* text is not proof our prompt was unsubmitted — it may be
operator input or a selector row — so that is `unknown`, as are an unlocatable boundary, a generic
busy state, an apparent transcript echo, an empty composer, an unreadable pane, and engines with no
wake vocabulary.

**Present only when measured.** A step that never asks omits both fields entirely — absent, never
`null` and never `'unknown'`: a step that did not look must not be recorded as one that looked and
could not tell. The pipeline builds each recorded row and each SSE `step-done`/`step-blocked` frame
from an explicit field list, so a field the contract does not name is dropped at that boundary. That
is exactly how `deliveryOutcome` was lost the first time it was wired.

**Readers may tolerate historical `accepted` rows** if compatibility requires it. Reintroducing it
as a writable value requires an engine-native acknowledgement or an authoritative transcript event
tied to the send's nonce — not rendered-pane inference — and another explicit amendment here.

`lib/wrap-delivery-receipt.js` is the only producer today, via the `ai-content` step.

