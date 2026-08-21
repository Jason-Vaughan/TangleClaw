# Backlog — TangleClaw

<!-- Structured product backlog. Add new items under ## Open.

Each item:
  - **[PFX-XXXX]** One-line title
    `effort: S|M|L · impact: S|M|L · area: <tag> · source: builder|critic|reflection|janitor|user · added: YYYY-MM-DD · status: open|promoted|shipped|dropped`
    Optional free-form body.

Metadata fields:
  - effort / impact   : S | M | L (relative sizing)
  - area              : work-space tag (e.g. session-rules, data-model, stop-hook)
  - source            : who surfaced it (builder|critic|reflection|janitor|user)
  - added             : YYYY-MM-DD filed
  - status            : open | promoted | shipped | dropped
  - related:          : related backlog item(s) (item→item)
  - closes:           : another backlog item this one supersedes (item→item)
  - closed-by:        : the chunk/release that shipped this item (item→release)
  - reviewed:         : YYYY-MM-DD last triaged/touched
  - accepted-by:      : @actor soft claim (someone working it; not a lock)
  - stage:            : idea | research | requirements | design | ready (only `ready` is buildable; no stage = not-yet-ready)
  - refs:             : links to governing docs (requirements/arch/design) — distinct from related:

Sections: ## Open (pickable) · ## Promoted (in an active build plan) · ## Archive (shipped/dropped, kept for search).
Items move between sections only via explicit /prawduct:backlog update calls.
Manage with /prawduct:backlog (pick, add, find, list, update, dedup, import, migrate). -->

## Open

- **[SEC-9Z2D]** Cross-machine secure clipboard sync and file/secret uploader
  `effort: M · impact: H · area: session-env · source: user · added: 2026-07-09 · status: open · stage: idea`

  Provide a mechanism to securely sync clipboards or upload sensitive strings/files from the client device (e.g. cursatory) into the remote TangleClaw session host workspace (e.g. elkaholic) without exposing them in logs, chat histories, or terminal command histories. Useful for passing API keys, secrets, or SSH credentials securely.

<!-- Batch-added 2026-07-09 from janitor codebase survey -->

- **[PRJ-8M2X]** Refactor updateProject grab-bag into per-field validator table + two-phase validate/apply
  `effort: L · impact: M · area: projects · source: janitor · added: 2026-07-09 · status: open · stage: idea · reviewed: 2026-07-19`

  `updateProject` (`lib/projects.js` ~1626-2022, 397 lines) mixes validation + DB writes + disk writes + methodology switching for ~a dozen PATCH fields; it documents a past partial-update bug that the shape keeps inviting. Refactor to a per-field validator table + two-phase **validate-all → apply-all** so no field is written before all are validated.

- **[SES-5W9D]** Model session status as an explicit enum + allowed-transition map
  `effort: M · impact: M · area: sessions · source: janitor · added: 2026-07-09 · status: open · stage: idea · reviewed: 2026-07-19`

  Session status is encoded as scattered SQL string literals (`'active'`/`'wrapping'`/`'wrapped'`/`'killed'`/`'crashed'`/`'degraded'`/`'ended'`) across `store.js` `sessionsApi` and `sessions.js` with no `SESSION_STATUS` enum or allowed-transition map. Model it explicitly (enum + transition table), mirroring the existing `SESSION_RULE_KINDS` pattern.

  **2026-07-18 — 'wrapping' is now production-unenterable on the write side (Chunk 05, prawduct-v2-sunset).** Chunk 05 stripped the legacy NL-prompt wrap, which was the LAST production caller of `store.sessions.setWrapping` — no production path can enter the `'wrapping'` status anymore, while its read-side ecosystem stays live for pre-existing rows and the manual-complete flow (`completeWrap`, `POST /wrap/complete`, `autoCompleteWrap`'s wrapping branch, stale-wrapping recovery, session-ownership's wrapping-is-live rule). When this item models the status enum + transition map, decide whether `'wrapping'` survives as a state or the machinery collapses into the Wrap v2 (Phase B) redesign. The same sweep should consider renaming the now-vestigial "V2" designators (`_triggerWrapV2`, `_completeV2Wrap`, "V2 lifecycle" log strings, wrap-run-registry header) — the V1/V2 distinction no longer exists.

- **[STO-7J4B]** Retire idempotent one-off migration shims that run on every config load
  `effort: M · impact: S · area: store · source: janitor · added: 2026-07-09 · status: open · stage: idea · reviewed: 2026-07-19`

  Idempotent one-off migration shims run on every config load: `store.js` ~580-583 (engine id `'claude-code'`→`'claude'`), ~600-607 (#151 methodology `null`→`minimal`), ~3637-3696 (#240 legacy global-rules-file detect/backup/warn). Retirement candidates once no pre-migration on-disk artifacts remain in the field — **needs field-state confidence, do NOT remove blindly.**

  **2026-07-19 — inventory addition (Chunk 06a Critic sustainability pass, C-B3):** the 06a minimal-migration seed — `seedCommitOnlyWrapOverrides` plus its `wrapOverridesSeeded` marker in project.json (`lib/projects.js`) — joins the one-off-shim inventory. Removable once #538's second half (06b) lands and its precondition sweep confirms every minimal row is seeded.

  **2026-07-18 — exclusion note (Chunk 03 cumulative Critic, C-B3):** the `RETIRED_TEMPLATE_IDS` tombstone pass added to `_copyBundledTemplates` in Chunk 03 (prawduct-v2-sunset) is **intentional-permanent, NOT a boot-time shim to retire** — same class as the `RETIRED_ENGINE_IDS` pass. A future shim-retirement sweep under this item must not delete it.

- **[TST-4X8N]** Add focused unit tests for wrap-steps submodules and server.js
  `effort: M · impact: M · area: tests · source: janitor · added: 2026-07-09 · status: open · stage: idea · reviewed: 2026-08-10`

  Test-depth gaps despite strong breadth: `lib/wrap-steps/*` submodules (lint, pr-check, priming-roll, test) and `server.js` (159KB) are covered only via giant integration tests (`wrap-pipeline.test.js` 208KB, `api-*`). Add focused unit tests for faster feedback + better failure localization.

  **2026-08-10 — first focused per-module suites landed (branch `fix/897-killed-vs-failed-sweep`), item stays OPEN.** The killed-vs-failed sweep added the first two test files that require wrap-step submodules directly instead of driving them through the wrap pipeline: `test/wrap-step-killed-vs-failed.test.js` (requires `commit`, `pr-check`, `pr-merge`, `continuity-write`, plus `_exec-shell`) and `test/wrap-step-git-range-killed.test.js` (requires `_git-range`, `changelog-coverage`, `features-toc`, `ai-content`). That is the pattern this item asks for — per-module require + synthetic inputs, no 208KB pipeline harness — so it is a template to copy, not a partial fix. **Still uncovered by any focused suite: `lint`, `priming-roll`, `test`, and `server.js`** (the largest remaining gap). The suites above were written to pin killed-vs-failed timeout semantics, so their coverage of the modules they touch is narrow by construction — a module appearing in that require list is not the same as that module being unit-covered.

- **[TST-6L2P]** Reduce brittleness of frontend tests that regex-match exact public/* source text
  `effort: M · impact: M · area: tests · source: janitor · added: 2026-07-09 · status: open · stage: idea · reviewed: 2026-08-13`

  ~17-22 frontend tests assert on exact `public/*` source text via regex string-matching (brittle; break on cosmetic refactors) — a structural consequence of the zero-dep/no-browser-harness choice. Consider a lightweight DOM-assertion approach, or accept + document the tradeoff.

  **2026-07-15 — a concrete zero-dep mitigation, demonstrated by #566.** This item's structural gap (source-probes over `public/*.js` text, no DOM harness) was the named cause of a real escape: #566 (loops panel dismissing itself on a synchronous click) shipped past both the unit tests and T4's VRF because a DOM-detachment bug is invisible to regex-matching. The #566 fix demonstrated a technique worth generalizing: **extract the decision into a pure function, then lift it out of the browser file with `new Function` in the test and execute it against synthetic objects** (`test/medusa-control.test.js` → `loadClickHitsSelector`). That yields genuine behavioral coverage with zero new dependencies and no browser. **Scope limit — this does NOT resolve the item:** it only works for logic that is pure and DOM-free once extracted. Anything touching real DOM state (render output, focus, event wiring, layout) still has no harness and still falls back to brittle source-probes. Treat it as a pattern to reach for when a frontend behavior can be refactored into a pure predicate, not as a general answer.

  **2026-07-17 — first candidate identified (Critic C-B3 on auth-5n2j).** The new `_authStatusWarning` structural pin in `test/auth-status-warning.test.js` is a pure, DOM-free function — the ideal first candidate for the documented `new Function` behavioral-lift pattern above: lift it out of the browser file and execute it against synthetic objects for genuine behavioral coverage instead of a source-text pin.

  **2026-07-18 — territory grew (Chunk 07 Critic, rev-20260718T220504Z).** `test/master-settings-frontend.test.js` landed as another all-source-regex frontend test file — squarely this item's brittleness class. Add it to the sweep scope when this item is picked up; see also SR-6D3W (the widget-skeleton extraction it pins).

  **2026-07-19 — territory grew again (Chunk 05b Critic, rev-20260720T054319Z).** `test/wrap-rule-proposal-widget.test.js` landed as another all-source-pin frontend test file (follows the wrap-drawer-select-a11y convention). Add it to the sweep scope alongside `test/master-settings-frontend.test.js`.

  **2026-08-13 — the item both advanced and grew territory (#885 chunk 03).** `test/degraded-reads-frontend.test.js` is the **largest application yet** of the documented `new Function` behavioral-lift pattern: `renderRootPanel`, `renderGitBadge`, `renderProjects`, `renderSessionCount`, `renderSessionDetail`, and `renderGitDetail` are all lifted out of the browser file and executed against synthetic objects (a shared `liftRenderer` helper does the lift). The same session also produced **hard evidence for this item** — two source-regex guards were proved *vacuous* while being written: one was satisfied by a **dead branch** (surfaced by a `countLabel = false` mutation), and one by a **substring collision** (the class `badge-git-unknown` contains the substring `git-unknown`, so the pin matched text that could never fail). Both were replaced by lifted execution. Two structural pins were kept **deliberately** and are documented in-file as the exception: `toggleCardDetail` (DOM-touching, so its third state was extracted into pure `renderSessionDetail`/`renderGitDetail` rather than lifted directly), and the spread-vs-re-list record guard, whose protected property is *structural* — no behavioural test can exist for it. Add `test/degraded-reads-frontend.test.js` to the sweep scope.

- **[TL-3D5K]** Hold formatting/style consistency without a linter — the residue after the enforcement ruling
  `effort: M · impact: S · area: tooling · source: janitor · added: 2026-07-09 · status: open · stage: idea · reviewed: 2026-08-01 · related: NRM-5K8T · refs: .prawduct/artifacts/project-preferences.md § Direction (no npm dependencies)`

  _Filed 2026-07-09 as "Configure a zero-dep-friendly linter/formatter"; retitled 2026-08-01 when the ratified enforcement ruling foreclosed that means. Original body preserved below._

  No linter/formatter is configured (CONTRIBUTING says "match what's there"). Combined with no CI, nothing mechanically enforces style, the JSDoc-on-all-functions rule, or the zero-dep constraint. Consider a zero-dep-friendly linter.

  **2026-08-01 — collision with the ratified enforcement ruling; premise invalidated.** The ruling is that **an enforcement mechanism must add no installation step** — it runs inside the existing `node --test` invocation (a source-scanning test in the `test/master.test.js:270` style) or the norm is janitor-homed. The reasoning: every dependency this product has is *product function* (tmux runs sessions, Caddy terminates TLS); a governance check is not, so it may not push an install onto every machine — including a non-expert field install — and a checker that is absent either fails the run or silently skips and reports green. This forecloses npm linters and brew-installed linters alike. The *need* this item named is real and confirmed; its *proposed means* is foreclosed. Do not re-evaluate linters — that afternoon is already spent.

  **Correction, same day:** this note first cited the ruling as "may not be bought with a dependency," resting on a "TangleClaw has zero dependencies" framing that is false — `dependency-manifest.md` lists eleven. The ruling was re-derived on the no-install-step principle above, which survives the correction and reaches the same answer for linters.

  - **JSDoc-on-all-functions half → served by NRM-5K8T** (check (e), a source-scanning `node --test` check in the `test/master.test.js:270` style); the current residual sites are DOC-2Q7X.
  - **Zero-dep-constraint half → served by NRM-5K8T** (check (b)).
  - **CI half → shipped** (CI-9F3T ran the suite on PRs; CI-2V8Q made it required).
  - **Residue this item still carries: formatting and general style** — 2-space indent, quote style, semicolons, naming conventions. No mechanism exists for it, and any mechanism must run inside `node --test` with no install, which no formatter does. Realistically this survives as **convention plus review** (CONTRIBUTING's "match what's there", plus the Critic), not as tooling — the item stays open to say so honestly, not because tooling is coming.

  Kept open rather than closed: it was never done. If the residue is later judged too thin to carry, mark it `status=dropped` with `closes:`/`related:` pointing at NRM-5K8T — **not** `shipped`.

- **[DEP-8H7W]** Suppress node:sqlite ExperimentalWarning via --disable-warning flag
  `effort: S · impact: S · area: deploy · source: janitor · added: 2026-07-09 · status: open · stage: idea`

  `node:sqlite` is used experimentally with no `ExperimentalWarning` suppression. The Node-22 startup guard shipped (janitor quick-wins); the warning-suppression half was deferred because it needs a plist/CLI flag change (deploy touch). Add `--disable-warning=ExperimentalWarning` to the launchd plist + the `node --test` invocation.

<!-- MED-2K9P switchboard follow-ups — captured 2026-07-09 (operator, capture-only; not for the current pass) -->

- **[MED-4T7K]** Accept an inbound Medusa message and insert it into the session
  `effort: M · impact: M · area: ui/integration · source: user · added: 2026-07-09 · status: open · stage: idea · related: MED-2K9P`

  Paste received cross-session text into the prompt / terminal input of the live session — a manual, user-driven insert of an inbound Medusa message (as opposed to a passive badge/notification). Needs discovery. Overlaps MED-2K9P's v2 auto-inject theme but is the *manual* variant (user clicks to insert rather than auto-relay).

- **[MED-6P2N]** Auto-toggle mode for the Medusa control
  `effort: M · impact: M · area: ui/integration · source: user · added: 2026-07-09 · status: open · stage: idea · related: MED-2K9P, MED-4T7K`

  An auto-open / auto-relay mode for the Medusa banner control: inbound messages surface (and optionally relay) without a manual click. Needs discovery. Sits between the manual insert (MED-4T7K) and fully autonomous relay (MED-9X3B).

- **[MED-9X3B]** Autonomous relay mode (unattended switchboard)
  `effort: L · impact: M · area: ui/integration · source: user · added: 2026-07-09 · status: open · stage: idea · related: MED-2K9P, MED-6P2N`

  The switchboard runs unattended, auto-inserting inbound messages into the live session with no human in the loop. **FLAG — trust/safety surface:** this is command injection into a live terminal by design; it needs its own dedicated design + threat model before ANY code is written. Needs discovery (and a threat model as part of that discovery). Highest-risk of the three.

- **[MED-8H5W]** Session Switchboard v2 — auto-inject + agent-to-agent round-trip loop
  `effort: L · impact: M · area: ui/integration · source: user · added: 2026-07-10 · status: open · stage: idea · related: MED-2K9P, MED-6P2N, MED-9X3B · refs: /Users/jasonvaughan/Documents/Projects/TangleClaw/.claude/plans/switchboard-v2-autoinject-loop.md`

  Auto-inject inbound messages into the live session plus an **agent-to-agent round-trip loop** (delegation that continues until task-complete), fronted by an **operator settings panel** (autonomy, max-turns, budget, idle-gating, done-sentinel, kill switch) and **runaway guards**.

  **Staged rollout:** one-way inject → supervised round-trip → guarded autonomous loop → reliable delivery.

  **Dependency:** the autonomous loop stage depends on Medusa#33 (at-least-once delivery). Builds on MED-2K9P v1 (badge-receive), and is the v2 "auto-inject" that MED-2K9P's notes flag as gated on Medusa#33.

  **FLAG — trust/safety surface:** inherits MED-9X3B's concern (command injection into a live terminal, now with an autonomous delegation loop); needs a dedicated threat model + the runaway guards designed before any autonomous-stage code. Discovery/hardening of the staged plan into buildable requirements is the next step.

  Plan: `/Users/jasonvaughan/Documents/Projects/TangleClaw/.claude/plans/switchboard-v2-autoinject-loop.md`.

- **[TST-8V2Q]** Tighten FEATURES.md citation-contract coverage
  `effort: S · impact: S · area: tests · source: critic · added: 2026-07-17 · status: open · stage: ready · related: DOC-3K7Q`

  Critic notes on DOC-3K7Q (PR #591): `test/features-index.test.js` only verifies backticked slash-containing committed-root paths — root-level anchors (`server.js`), bare secondary `#symbol` refs, and quoted route strings fall outside all pins; the `#symbol` pin uses substring `includes()` which common names can false-pass (word-boundary regex would be stricter). Deliberate false-pass bias at ship time; tighten when convenient. Type: chore.

- **[PRW-9K4C]** regen-views fail-closed validation hard-blocks every planless small-fix release window (upstream prawduct defect, 3.0.5)
  `effort: S · impact: M · area: prawduct-upstream · source: builder · added: 2026-07-17 · reviewed: 2026-07-17 · status: open · stage: research · related: ART-7W2J, PRW-5N8T`

  **Upstream prawduct defect, not a TangleClaw bug** — captured here via report-bug fallback because no PRAWDUCT_BUG_INBOX is configured. Reportable at https://github.com/brookstalley/prawduct/issues.

  **Contradiction:** regen-views' fail-closed validation (upstream id VWS-6R4T, prawduct 3.0.5) contradicts the pr skill's own Step 1c requirement for planless small work. Step 1c mandates a `scope=`-tagged change-log entry on every code PR; the size scaling says small work needs no build plan; `diagnose_scope_plan_coverage` then ERROR-flags that scope as "release-pending but has no matching build-plan file", and fail-closed aborts regen with NO views written for ANY scope. Net effect: every repo following the documented single-PR bookkeeping has regen hard-blocked during every merge→release window of every planless small fix — the common case. This was a non-fatal warning under 2.1.5.

  **Observed live in TangleClaw 2026-07-17:** fresh scope `auth-5n2j` (merged 1h earlier per the documented flow) was error 1 of 12 blocking all views; the other 11 were TC-local rot, fixed under ART-7W2J.

  **Suggested upstream fixes (any one suffices):** downgrade planless-unreleased to WARNING; per-scope isolation instead of global abort; or a declared allowance (a `plan=none` tag token / config list). Upstream ids in source: VWS-6R4T, REL-9F2T, BLD-4Q9X.

  **2026-07-17 — operator decision: NOT filing upstream; PARKED (stage demoted ready → research).** Reassessment: the standing local recurrence was TC-specific, not natively upstream — TC's merged-at-merge intermediate state deviated from upstream's trunk rule (tag `shipped` in the closing PR), and TC has now conformed (change-log header amended, commit 2ff8278; regen-views runs clean, zero errors). The only case that would be natively upstream (gitflow develop→main release windows) is UNVERIFIED against upstream's release docs, so confidence is too low to post to brookstalley/prawduct. **Re-open the filing question only if:** (a) the gitflow case gets verified against upstream docs, or (b) a new non-self-inflicted hit occurs. Until then this is a watch item — do not pick for implementation.

- **[PRJ-2F8W]** Visible diagnostic for persistent project-version-cache write failures
  `effort: M · impact: M · area: projects · source: critic · added: 2026-07-17 · status: open · stage: idea · related: PRJ-7C4V`

  `recordVersion`'s never-throws warn-and-bail contract hid a 100%-failure bug (#584) in unwatched logs — the cache had been silently failing every write since #101 with no operator-visible signal. The contract itself is correct (version-cache writes must never block the caller); what's missing is a surfaced health signal when failure is *persistent*: e.g. a dashboard/health indicator, a cache-staleness check (recorded-at vs now), or a failure counter that escalates past a threshold. Shape needs design — that's the discovery work. Type: feature (observability). Source: Chunk 01 cumulative Critic review.

- **[SR-6D3W]** Extract the shared session-rules widget skeleton duplicated between Project Rules and the Master settings modal
  `effort: M · impact: M · area: session-rules · source: critic · added: 2026-07-18 · status: open · stage: ready · related: TST-6L2P · reviewed: 2026-07-19`

  `public/ui.js` carries two copies of the same session-rules widget skeleton — row renderer + the add/toggle/delete/delegated-handler quartet — one in the Project Rules section, one in the Master settings modal. Critic R-5 (rev-20260718T220504Z, Chunk 07 review) left this open **deliberately**: two copies are tolerable; the extraction bar is **a third rules surface copying the pattern, or sooner** if either copy needs a behavior change. When triggered, extract a shared widget skeleton both surfaces instantiate. Type: refactor.

  **2026-07-19 — extraction trigger fired; decision: NOT extracting yet.** Chunk 05b changed the Project Rules copy's behavior (Proposed badge, inert toggle, Approve/Reject affordances; the fetch quartet refactored into `fetchProjectRules`) — the "either copy needs a behavior change" bar was met. Reviewed against the Chunk 05b cumulative Critic (rev-20260720T054319Z) and deliberately deferred: the two surfaces still differ in kind semantics (Master modal vs Project Rules) and the change was additive, so extraction now would buy little. The trigger has now fired once; the next behavior change to either copy — or a third surface — should extract.

  **2026-08-16 — one copy MOVED; the trigger did not fire.** #768 chunk 1 lifted the Master
  settings modal, session-rules widget included, out of `public/ui.js` into
  `public/api-helper.js` as `tcCreateMasterSettings`. This item's opening line — "`public/ui.js`
  carries two copies" — is now wrong: the copies are one per FILE, Project Rules in `ui.js` and
  the Master's in `api-helper.js`, which makes them harder to diff by eye, not easier. The
  extraction bar was deliberately NOT met: chunk 1 preserved the Master copy's behaviour
  exactly (`test/master-launch-mode.test.js` lifts and runs it against byte-identical
  assertions), so this is a move, not a behaviour change. The trigger still stands at: the next
  behaviour change to either copy, or a third surface. Note that #768 chunk 2 mounts the Master
  modal on the session page — a second SURFACE for the same copy, which is not a third copy and
  does not fire it either.

- **[SR-4N6C]** POST /api/session-rules/:id/restore returns CONFIRM_REQUIRED instead of NOT_FOUND for nonexistent versionNo on baseline master rules
  `effort: S · impact: S · area: session-rules · source: critic · added: 2026-07-18 · status: open · stage: ready`

  When a restore on a baseline master rule targets a `versionNo` that doesn't exist, the endpoint answers `CONFIRM_REQUIRED` (the baseline-confirm check fires before the version-existence check) rather than `NOT_FOUND`. Fail-closed, so no correctness harm — but the error is misleading: the caller is told to confirm an operation that can never succeed. Fix: reorder the checks so version existence is validated first. Cosmetic; from the Chunk 07 Critic review (rev-20260718T220504Z). Type: bug (cosmetic).

- **[PRJ-4T7G]** Extend stranded-config guard detection beyond Claude artifacts (gemini parity)
  `effort: S · impact: M · area: projects · source: critic · added: 2026-07-17 · status: open · stage: ready`

  `STRANDED_CONFIG_FILES` in `lib/projects.js` covers only `CLAUDE.md` and `.claude/settings.json`, but TC also generates `.gemini/GEMINI.md` for gemini-engine projects (`lib/engines.js`), and Gemini CLI performs the same ancestor context walk — so the identical stranding hazard class goes undetected for gemini projects. The constant makes extension trivial: add the gemini artifacts to the detection surface. Type: enhancement. Source: Chunk 02 cumulative Critic design note (PR #592).

- **[WRP-3P9K]** Migrate the 12 projects with plans in legacy `.claude/plans` to `.tangleclaw/plans`, then retire the priming-roll legacy fallback
  `effort: S · impact: M · area: wrap · source: user · added: 2026-07-18 · status: open · stage: ready · reviewed: 2026-08-10`

  Twelve projects still keep their build plans under the legacy `.claude/plans` location, which is why `lib/wrap-steps/priming-roll.js` carries a legacy-path fallback. Migrate those projects' plans to `.tangleclaw/plans`, then delete the fallback so there is one canonical plan location. Order matters — retire the fallback only after all 12 are moved, or priming-roll silently stops resolving their plans. Note `MED-8H5W` still `refs:` a `.claude/plans/switchboard-v2-autoinject-loop.md` path; update that reference (and any others in memory/plans) as part of the sweep.

  Re-point each project's stored `activePlan` alongside its files. Resolution prefers the directory that *contains* plans, so a project whose `activePlan` names a legacy plan starts erroring the moment its `.tangleclaw/plans/` gains a first `.md` — the pick and the files must move together, not in separate passes. Type: chore.

  **2026-08-10 — assessed against the #897 killed-vs-failed sweep (`fix/897-killed-vs-failed-sweep`): NOT touched, no status change.** That branch changed nine `lib/wrap-steps/*` modules but `priming-roll.js` is not among them, so the legacy `.claude/plans` fallback this item exists to retire is still in place, unmodified. Re-confirming so a future reader doesn't mistake "the wrap-steps sweep landed" for "this was handled by it."

- **[WRP-5H2T]** version-bump's changelog promotion emits bracketed headings without matching link-reference definitions
  `effort: S · impact: S · area: wrap · source: critic · added: 2026-07-19 · status: open · stage: ready · reviewed: 2026-08-10`

  The `[Unreleased]` promotion writes bracketed headings (`## [X.Y.Z] - <date>`) but never emits the corresponding link-reference definition (`[X.Y.Z]: <url>`). In a project that maintains a link-def block at the bottom of `CHANGELOG.md`, every promoted heading renders as a broken reference.

  **2026-08-10 — assessed against the #897 killed-vs-failed sweep (`fix/897-killed-vs-failed-sweep`): NOT touched, no status change.** `lib/wrap-steps/version-bump.js` does appear in that branch's diff, but the change is a **doc-comment only** (+9 lines) recording *why* the step is out of the sweep's scope: it spawns no child process, so it has no timeout to misread as a failure — #897 had listed it on the strength of eleven `.exec(` matches that all turn out to be `RegExp.prototype.exec`. No promotion logic changed, so the missing link-reference definitions remain exactly as described above.

  Pre-existing, not introduced by recent work. TangleClaw's own `CHANGELOG.md` carries no link defs, so TC is unaffected — this bites other projects whose changelogs use the reference style. Found during Chunk 04a review.

  Fix direction: when the file already has a link-def block, emit a definition alongside the new heading, inferring the compare-URL shape from the existing entries (do nothing when no block is present). Type: bug.

- **[PTH-6R2K]** Unify the two project-containment predicates behind one helper with an explicit root policy
  `effort: M · impact: S · area: paths · source: critic · added: 2026-07-19 · status: open · stage: ready · related: SEC-3H8W`

  `resolveWithinProject` in `lib/project-paths.js` requires a file *strictly inside* the project and now follows symlinks; `lib/wrap-steps/priming-roll.js:474` hand-rolls its own check (`abs === projectRoot || abs.startsWith(projectRoot + path.sep)`) which counts the root itself as inside and is purely lexical.

  The difference is semantic and intentional today (priming-roll validates directories, not a target file), so this is **not a bug** — but two containment predicates that disagree on the root case is the exact drift shape Chunk 04a spent two Critic rounds eliminating in the version-bump classifier.

  Fix direction: add an `allowRoot` option (and symlink resolution) to `resolveWithinProject`, migrate priming-roll's three call sites, then narrow the scope caveat in `project-paths.js`'s module docstring. Type: refactor.

- **[SR-8V4T]** Compare-and-set on rule-proposal approval — status PUT can ratify content the operator never saw
  `effort: S · impact: M · area: session-rules · source: critic · added: 2026-07-19 · status: open · stage: ready`

  `PUT /api/session-rules/:id/status` approving a proposal to `active` activates whatever content the DB row holds at that moment, while the operator's surface (wrap-drawer widget / Project Rules modal) shows a snapshot; content edits via `PUT /:id` are ungated, so text could be swapped between wrap and approval and the operator would ratify text they never saw. Fix direction: send the displayed content (or an expected-content/version token) with the status PUT and refuse on mismatch. Files: `public/session.js`, `server.js`. Source: Chunk 05b cumulative Critic rev-20260720T054319Z R-2 (note). Type: bug (integrity).

- **[SR-2W7F]** fetchProjectRules renders API failure identically to an empty list ("No rules yet.")
  `effort: S · impact: S · area: session-rules · source: critic · added: 2026-07-19 · status: open · stage: ready · related: SR-6D3W`

  `fetchProjectRules` (`public/ui.js`) shows the same "No rules yet." state for a failed fetch and a genuinely empty list, so an API outage looks like an empty ruleset. Pre-existing shape, but the Chunk 05b refactor centralized the fetch quartet into `fetchProjectRules`, so there is now exactly one place to fix it: return `null` on failure and render a distinct error via `_setProjectRulesStatus`. Source: Chunk 05b cumulative Critic R-5 (note). Type: bug (cosmetic/UX).

- **[AUTH-4B7K]** A stored `bindAllInterfaces: true` is invisible in caddy mode — switching back to direct mode reopens a wide bind nothing named
  `effort: S · impact: L · area: auth · source: critic · added: 2026-07-27 · status: open · stage: ready · related: AUTH-2K9D · refs: #710 · reviewed: 2026-07-29`

  In caddy ingress mode the bind-host toggle is locked and renders from the **effective** binding (loopback), so it shows OFF even when the persisted config holds `bindAllInterfaces: true`. Nothing in the UI names the stored value, so an operator who later switches back to direct mode silently reopens a wide bind from a choice made in an earlier session.

  Options: (a) clear the key when caddy mode refuses it, so stored state matches what the UI shows; or (b) keep the key but name the stored value in the locked hint ("stored: bind-all — will apply if you leave caddy mode").

  Same shape as AUTH-2K9D (a stored setting that is inert in the current mode and therefore unsurfaced), applied to bind host rather than `authEnabled`.

  Found by the Critic on #710 chunk 1 (verify-resolutions, NOTE). **Mitigated today, not fixed:** the refusal is logged on every boot and the toggle renders ON again once direct mode is restored — so the state is recoverable and observable in logs, just not in the UI at the moment of the decision.

  **#710 chunk 2 widens this from rare to universal (impact M → L).** Chunk 1 left this as an edge case reachable only by an operator who had deliberately switched into caddy mode. Chunk 2 makes setup **provision caddy mode by default**, so every install that had ever opted into `bindAllInterfaces: true` — or that was being held wide by the legacy grace state — now lands in the mode where that stored key is inert and unnamed in the UI. The invisible-stored-value case becomes the default population, not an outlier. Compounding it, `ingress-cutover --rollback` returns an install to direct mode and thereby **reopens a wide bind that chunk 2 also leaves ungated**, with nothing in the rollback path naming what the stored value will do on the next boot. Option (b) (name the stored value in the locked hint) gains weight over (a) accordingly, and the rollback path deserves the same naming.

- **[AUTH-6D9P]** ttyd exposure is derived by enumerating wide binds, so a LAN-IP-bound job is exposed but reports not-wide (no notice fires)
  `effort: S · impact: M · area: auth · source: critic · added: 2026-07-28 · status: open · stage: ready · related: AUTH-4B7K · refs: #710 · reviewed: 2026-07-29`

  ttyd exposure is derived as "0.0.0.0 or no `--interface`", but the operator-facing notice it gates says "still accepting connections from your whole network". A job hand-bound to a specific LAN IP therefore reports not-wide while genuinely exposed, so no notice fires.

  **Not a regression** — the pre-#710 constant suppressed the notice in this case too.

  Fix direction: derive exposure as "neither loopback nor a unix socket" rather than enumerating the wide forms; or, if the narrow derivation is intentional, document the exclusion on `describeInstalledBind`.

  Found by the Critic on #710 chunk 1 (verify-resolutions, NOTE).

  **Scope note (#710 chunk 2):** the exposure sentence chunk 2 adds to setup is deliberately scoped to the **dashboard listener** — it describes only how TC's own server is bound, so it does **not** consume the ttyd derivation this item describes and is unaffected by the narrow-derivation defect. Fixing this item does not require revisiting that sentence, and the sentence's presence is not evidence the ttyd case is covered.

- **[ENG-7Q3M]** Detect drift in engine-declared `startupInjection.maxChars` against its upstream source
  `effort: M · impact: M · area: engines · source: critic · added: 2026-07-28 · status: open · stage: research · refs: #749 · related: PRM-4H8N`

  The `10000` in `data/engines/claude.json` is an **upstream** fact about Claude Code's hook-output cap, verified against its hooks reference 2026-07-28. Nothing detects it changing.

  This is the exact shape of the recorded `codex.json --full-auto` learning: an assertion whose both sides are our own repo stayed green for months after the upstream flag had been removed. Prose acknowledgment now exists in the resolver JSDoc and `docs/engine-guide.md`, but the finding was that **detection**, not acknowledgment, is the gap.

  Options to weigh:
  - (a) a periodic probe that measures the real cap by emitting a known-length payload and observing whether it is replaced by a preview;
  - (b) an operator-visible override so a wrong bundled value can be corrected without a release;
  - (c) a dated re-verify reminder tied to the engine profile.

  Also unresolved: **no other engine declares the field**, so codex / gemini / antigravity / aider silently take the 16,000 fallback with no probe behind it.

  Second item folded in (also filed standalone as **PRM-4H8N**): `summarizeFeatureIndexForPrime` is now runtime-unused (only its own tests) since the prime carries a census rather than the curated body — decide remove vs keep.

- **[PRM-4H8N]** Decide remove-vs-keep for the now-runtime-unused `summarizeFeatureIndexForPrime`
  `effort: S · impact: S · area: engines · source: critic · added: 2026-07-28 · status: open · stage: ready · refs: #749 · related: ENG-7Q3M`

  Since the prime carries a **census** rather than the curated body, `summarizeFeatureIndexForPrime` has no runtime caller — only its own tests exercise it. Decide: delete it (and its tests), or keep it with a documented reason for the retained-but-unused shape.

  Split out of ENG-7Q3M so the decision isn't archived along with the drift-detection work. Per the `prove-absence-before-deleting` learning, confirm the absence of callers **repo-wide** (not from a bounded grep window) before removing.

- **[UPD-3F7Q]** Add a short failure back-off to the update-checker's origin lookup so a degraded install stops re-spawning execSync on every check
  `effort: S · impact: S · area: update-checker · source: critic · added: 2026-07-28 · status: open · stage: ready · refs: #716`

  `_getReleasesUrlBase` (`lib/update-checker.js`) deliberately does **not** memoize a failure — a cached failure would permanently strip the release-notes link — so once the origin lookup has failed, every measurement pays a fresh bounded synchronous `execSync` spawn, up to a 2s timeout, inside `checkForUpdateAsync`'s completion path. A degraded install therefore re-stalls on every check.

  **Not urgent:** the staleness floors bound the check cadence today, so the repeated spawn is capped in practice.

  Fix direction: a short failure back-off (retry only after N seconds/minutes rather than never or always) gets both properties — no permanent loss of the release-notes link, and no repeated stall.

  Raised as a residual by two consecutive Critic passes on #716. Files: `lib/update-checker.js#_getReleasesUrlBase`. Type: enhancement (performance).

- **[UPD-7B4X]** Route the update-checker's synchronous `git ls-remote` through the `_internal` seam so its failure path can be driven from a test
  `effort: S · impact: S · area: update-checker · source: critic · added: 2026-07-28 · status: open · stage: ready · refs: #716 · related: UPD-3F7Q`

  `checkForUpdate` calls `execSync` inline while `checkForUpdateAsync` goes through `_internal.lsRemote`, so the **sync** failure path cannot be exercised behaviorally.

  The current guard for it is a source-text grep asserting exactly two `log.warn('Update check failed` occurrences with a hardcoded count (`test/update-checker.test.js` ~line 491). It catches a half-applied change today, but it is brittle and reads module text rather than behavior. Adding the seam lets that grep be replaced by a real test.

  Raised as a residual by two consecutive Critic passes on #716. Files: `lib/update-checker.js#checkForUpdate`, `test/update-checker.test.js`. Type: chore (testability).

- **[UPD-5K9V]** Make the manual update-check honest against a server older than the client, and test that path
  `effort: S · impact: M · area: update-checker · source: critic · added: 2026-07-28 · reviewed: 2026-08-15 · status: open · stage: ready · refs: #716 · related: UPD-3F7Q, UPD-7B4X`

  In the pre-restart window where the server predates `POST /api/update/check`, the client falls back to the cached `GET` — correct — but `wireVersionCheck` then renders "up to date ✓" for a check that **did not actually run**, because the old server's payload has no `checkOk` and the handler takes the else branch.

  Worse edge: against an old server with a **cold cache** (`checkedAt` null) the control contradicts itself — the version marker renders check-unknown while the transient label says "up to date ✓".

  Narrow (closes at restart) and deliberately not coded around during #716, since two rounds of follow-up fixes there had each introduced new defects.

  Fix direction: distinguish "served from an older server's cache" from "measured just now" — `checkOk` being `undefined` is the available signal — and add a `wireVersionCheck` test over the fallback path, which has none.

  Raised as a carried note by the #716 Critic. Files: `public/landing.js#wireVersionCheck`, `test/version-visibility.test.js`. Type: bug (correctness/UX).

  **Re-confirmed 2026-08-15 (during #931).** #931 edited both files this item names — `public/landing.js` and `test/version-visibility.test.js` — but deliberately left `wireVersionCheck` untouched: no diff hunk reaches its body (hunks jump from line ~63 to ~630; the function sits at ~412), and its name appears on zero changed lines. In the test file, #931's only touch inside the existing `wireVersionCheck` harness was adding an `updateBeacon` stub to the VM context. Every `clickVersion` case still supplies an explicit `checkOk` (`true`/`false`) or throws, so the `checkOk: undefined` fallback — the exact path this item is about — remains untested. Still open, still accurate; do not read the file-level overlap as "already fixed."

- **[ENG-6J8P]** Own shell-safety for generated hook commands in one place instead of at each call site
  `effort: S · impact: M · area: engines · source: critic · added: 2026-07-28 · status: open · stage: ready · refs: #759`

  `_buildBaselineHooks` now quotes both of its emitted commands, but each site carries its own quotes plus its own near-duplicate hazard comment, so a third hook begets a third copy of both — the exact shape of the miss that caused #759.

  Quoting is also only half the problem: double quotes still expand `$VAR` and `$(...)` under `/bin/sh`, and a literal double-quote or backslash in a directory name breaks the quoting outright. All are legal in a macOS directory name.

  Fix direction: escape once inside `_resolveHookPlaceholders` so the invariant is owned by the substitution rather than restated by every caller, and test the hostile cases (a dollar sign, a quote, a backslash) alongside the space.

  Raised as a Critic warning on the #759 fix. Files: `lib/engines.js#_resolveHookPlaceholders`, `lib/engines.js#_buildBaselineHooks`. Type: chore (robustness/DRY).

- **[PRM-7T3Q]** Hook delivery is recorded as success when the shards are WRITTEN, never when the hook actually runs — a total outage logs as delivered on every launch
  `effort: L · impact: L · area: prime-delivery · source: critic · added: 2026-07-28 · status: open · stage: design · refs: .prawduct/artifacts/prime-delivery-direction.md#direction-4, .prawduct/artifacts/build-plan-prime-delivery.md#chunk-04, #759, #749`

  `lib/sessions.js` logs `outcome: 'delivered'` at **write** time (`_recordRuleDelivery({ ...deliveryBase, channel: 'rules-hook', outcome: 'delivered' })`, ~line 459) — the record attests that shards were written to disk, not that any engine ever read them. So a delivery channel that is 100% broken still produces a clean ledger.

  **This is not hypothetical.** #759's outage — every Claude session start failing its `SessionStart` hook, booting with **no prime and no project rules** — produced a clean ledger on the affected install for as long as it lasted: multiple sessions, two projects, invisible to every delivery record TangleClaw keeps.

  **The #749 in-session detector cannot cover this**: it rides the prime channel, which is the channel that broke. A detector downstream of the failure point measures nothing when the failure is total.

  `prime-delivery-direction.md` § Direction 4 ("Delivery is confirmed, not assumed — and unconfirmed delivery says so") already forbids recording unverified delivery as success, and its answer — Design **D. Receipt and self-heal**, realized as `build-plan-prime-delivery.md` **Chunk 04: Receipt, ledger receipt rows, re-delivery** — is designed but unbuilt (chunks 01–02 shipped; 04 unchecked in `## Status`).

  **Why this item exists:** to carry the #759 incident evidence forward to whoever builds chunk 04. The design predates the outage; the outage is the proof that the ledger's current semantics hide exactly the failure mode the receipt is meant to catch. Cite it when sizing chunk 04's priority.

  `stage: design` (not `ready`) deliberately: the build plan's own confidence note asks for a pass enumerating the ledger's actual queries and their consumers (delivery panel, audit views) **before** the receipt fields are fixed — a persisted format is a lock-in decision regardless of size.

  Raised as a Critic warning on the #759 fix. Files: `lib/sessions.js`, `.prawduct/artifacts/prime-delivery-direction.md`. Type: bug (observability/correctness).

- **[PRW-6T2M]** verify-chunk-refs resolves plan refs against the symlink realpath, so it validates against the wrong worktree
  `effort: S · impact: M · area: prawduct-upstream · source: critic · added: 2026-07-29 · status: open · stage: ready · refs: #710, https://github.com/brookstalley/prawduct/issues · related: PRW-5N8T, PRW-9K4C`

  **Upstream prawduct defect, not a TangleClaw bug** — captured here because no upstream inbox is configured on this machine (`prawduct-hook bug-inbox` exits 1). Canonical tracker: https://github.com/brookstalley/prawduct/issues.

  `prawduct-hook verify-chunk-refs` resolves build-plan refs relative to the **realpath** of the plan file. In a git worktree whose `.prawduct/artifacts` is symlinked back to the primary checkout — the pattern this repo requires, since the primary checkout is also the live install — refs are therefore validated against the **PRIMARY** tree (`main`), not the worktree where the work lives. A file added on the branch reports `missing-ref: <path>: file does not exist` while being present and committed in the worktree.

  **Reproduced 2026-07-29:** worktree `.claude/worktrees/710-chunk2` on `feat/710-chunk2`; new `lib/ingress-provision.js` referenced from `build-plan.md`; the gate reports it missing.

  **Expected:** resolve refs relative to the worktree the command runs in (`git rev-parse --show-toplevel`).

  **Impact:** the gate is unusable as a signal in exactly the setup prawduct's own building guide recommends.

  **Secondary (minor):** a backticked route path in plan prose (`/api/health`) is parsed as a `file_path` and reported missing — either ignore leading-slash refs with no file extension, or document that route paths must not be backticked.

- **[PRW-4J8D]** Critic coordinator must pin the worktree path in reviewer prompts — dispatched subagents anchor to the primary checkout
  `effort: S · impact: M · area: prawduct-upstream · source: builder · added: 2026-07-30 · status: open · stage: ready · refs: https://github.com/brookstalley/prawduct/issues · related: PRW-6T2M, PRW-5N8T, PRW-9K4C`

  **Upstream prawduct defect, not a TangleClaw bug** — captured here because no upstream inbox is configured on this machine (`prawduct-hook bug-inbox` exits 1). Canonical tracker: https://github.com/brookstalley/prawduct/issues.

  The `/prawduct:critic` coordinator dispatches `prawduct:critic-reviewer` subagents without pinning an absolute worktree path in the reviewer prompt. A dispatched subagent's cwd defaults to the **primary checkout**, so its `git diff` / `Read` / `Grep` calls anchor to the wrong tree — it reviews `main` rather than the branch the work lives on, and reports files as absent that are present and committed in the worktree.

  **Expected:** the coordinator resolves the worktree root (`git rev-parse --show-toplevel`) and states it as an absolute path in every reviewer prompt, so each subagent scopes its reads and diffs to the tree under review.

  **Impact:** in the git-worktree setup prawduct's own building guide recommends, Critic findings are computed against the wrong tree — silently, since a reviewer that reads `main` still produces plausible-looking findings.

  **Same class as PRW-6T2M** (verify-chunk-refs resolving refs against the symlink realpath): both resolve paths against the primary checkout instead of the worktree the command runs in. Worth fixing together upstream.

- **[DOC-2Q7X]** Add JSDoc to the 9 undocumented private helpers
  `effort: S · impact: S · area: docs · source: user · added: 2026-08-01 · status: open · stage: ready · reviewed: 2026-08-20 · refs: .prawduct/artifacts/project-preferences.md § Direction (JSDoc on every function) · related: NRM-5K8T`

  **Retroactivity recorded at norm birth** — the "JSDoc on every function" norm was ratified by the operator 2026-08-01 with `Retroactivity: migrate`, and these are its only known residual sites: 9 of 684 top-level functions lack a preceding JSDoc block, all private helpers.

  Sites: `lib/store.js:1906` `_syncBundledEngines`, `lib/store.js:4016` `_maybeWarnLegacyGlobalRulesFile`, `lib/master.js:375` `deny`, `lib/git-template.js` `_hookPath`:58 / `_sentinelPath`:62 / `_readHookSource`:72 / `_writeSentinel`:154 / `_hasSentinel`:165 / `_removeSentinel`:173.

  **Census refreshed 2026-08-20 (Norm Health sweep).** The original 9-site list above is now a floor, not a census — a fresh scan found ~16 undocumented top-level functions, at least 7 postdating the 2026-08-01 ratification and not on the original list: `lib/wrap-steps/commit.js:513` `_autoPrCloseLoop`, `lib/wrap-steps/project-map.js:156` `_skipped`, `lib/wrap-steps/features-toc.js:712` `_skipped`, `lib/wrap-run-registry.js:137` `finish`, `lib/master.js:933` `decide`, `lib/master.js:955` `readLevel`, `lib/master.js:1585` `refreshFleetMap`. A full re-scan is still owed before this item can be closed as done — treat both lists as sites to fix, not a verified total, same caution TST-9B4L already carries for its own count.

  Comment-only change, no behavior. The norm was deliberately kept broad ("not only exported ones") rather than narrowed to match the code — narrowing would have been amending a norm to fit nine missing comment blocks. Closing these sites is what makes the broad rule true. Line numbers are as of 2026-08-01; re-locate by symbol name, not by line.

- **[TST-3M6R]** Switch `test/wrap-step-pr-merge.test.js` to `node:assert/strict`
  `effort: S · impact: S · area: tests · source: user · added: 2026-08-01 · status: open · stage: ready · refs: .prawduct/artifacts/project-preferences.md § Direction (tests are node:test + node:assert/strict) · related: NRM-5K8T`

  **Retroactivity recorded at norm birth** (testing-conventions norm, ratified 2026-08-01, `Retroactivity: migrate`). `test/wrap-step-pr-merge.test.js:9` is the only 1 of 201 test files still requiring `node:assert` rather than `node:assert/strict`.

  **Deliberately NOT a silent sweep.** Moving the file to strict changes what its `assert.equal` calls accept (loose `==` → `===`, including type coercion the current assertions may be relying on). Read the file's assertions, convert intentionally, and take the whole suite green afterward — a mechanical find-and-replace is the wrong shape here, which is why this was sized as backlog work instead of folded into the ratification sweep.

- **[TST-5N8W]** Switch `test/condition-log.test.js` to `node:assert/strict`
  `effort: S · impact: S · area: tests · source: janitor · added: 2026-08-20 · status: open · stage: ready · refs: .prawduct/artifacts/project-preferences.md § Direction (tests are node:test + node:assert/strict) · related: TST-3M6R, NRM-5K8T`

  `test/condition-log.test.js` uses non-strict `node:assert` — same defect class as TST-3M6R (`test/wrap-step-pr-merge.test.js`), found during the 2026-08-20 Norm Health sweep but not previously tracked. Same caution as TST-3M6R: moving to strict changes what `assert.equal` accepts (`==` → `===`, possible type-coercion reliance) — read the assertions, convert intentionally, take the whole suite green afterward. Not a mechanical find-and-replace.

- **[TST-9B4L]** Add tests for 4 API endpoints with no reference anywhere in `test/`
  `effort: M · impact: M · area: tests · source: user · added: 2026-08-01 · status: open · stage: ready · refs: .prawduct/artifacts/project-preferences.md § Direction (every API endpoint has tests) · related: TST-4X8N, NRM-5K8T`

  **Retroactivity recorded at norm birth** (testing-conventions norm, ratified 2026-08-01). Four of 109 route paths appear nowhere under `test/`: `/api/models/status`, `/api/openclaw/detect-instance-dir`, `/api/ports/sync`, `/api/projects/import`. Cover happy path plus error cases, per the norm.

  **The number 4 is a floor, not a census.** The inventory that produced it asked "does this path literal appear anywhere in `test/`" — which proves *reference*, not *coverage*. A route named in a test that never exercises its error paths (or never exercises it at all) counts as covered by that measure. Whoever picks this up should treat these 4 as the seed and *measure* coverage rather than trust the count; the true gap is at least this large and plausibly larger. NRM-5K8T's route-vs-test inventory mechanism would make this measurable rather than hand-taken.

- **[NRM-5K8T]** Build the norm-enforcement source scans marked "to build" in the Enforcement table
  `effort: L · impact: L · area: norms · source: user · added: 2026-08-01 · status: open · stage: ready · refs: .prawduct/artifacts/project-preferences.md § Enforcement · related: TL-3D5K, DOC-2Q7X, TST-3M6R, TST-9B4L`

  **Recorded at norm-registry ratification (2026-08-01), per the rule that a named-but-unbuilt enforcement mechanism is the aspirational failure with extra steps.** Every check below was run **by hand** at ratification — the Retroactivity lines in `project-preferences.md` § Direction are those results. This item is about making them **permanent**. Until they exist, the norms they back are effectively janitor-homed rather than mechanized.

  **Shape is ruled, not open.** Each is a source-scanning test in the existing `test/master.test.js:270` style — read the file as text, assert over its contents — running under `node --test`. Explicitly **NOT a linter**: the ratified ruling is that *an enforcement mechanism must add no installation step*. It runs inside the existing `node --test` invocation, or the norm is janitor-homed. This holds against npm and brew alike, and answers the next case (jq, a Python package, a Docker image) without a new ruling. Do not re-litigate it by proposing tooling.

  The checks:
  - (a) **Log secrecy** — no secret-shaped values inside `log.*()` calls (backs "logs carry names, never payloads").
  - (b) **No-npm-dependency invariant** — no `package.json` anywhere in the tree, no `node_modules`, no ESM `import`/`export` in `lib/` or `server.js`, no bundler/transpiler config. (Scope: this checks the npm package graph. TangleClaw's eleven *system* dependencies are inventoried in `dependency-manifest.md` and are not in scope.)
  - (c) **`'use strict'`** present in every `lib/*.js` and in `server.js` (two files carry it beneath a leading header comment — the check must tolerate that).
  - (d) **Route-vs-test inventory** for endpoint coverage (see TST-9B4L: a path-literal scan is a floor; aim the mechanism higher if it is cheap to do so).
  - (e) **JSDoc** present on every top-level `function` declaration (see DOC-2Q7X for the 9 current residual sites — build this after they are closed, or it lands red).
  - (f) **No `console.*`** outside the named bootstrap exemption in `server.js`: the Node-22 version check (must run before `node:sqlite` is required), the already-running PID exit, and the restart-exec callback — re-locate by message/callback, not by line, these drift as the file grows. The boundary is the logger's availability; the exemption is a fixed list, not a pattern.
  - (g) **Magic DNS** — literal-IPv4 scan over `lib/*.js` + `server.js`, excluding loopback (backs "remote hosts by Magic DNS, never literal IPs").

  **Count discrepancy to reconcile while building:** the Enforcement table carries **seven** rows marked **to build** (the six lettered (a)–(f) plus the Magic DNS scan (g)), while the prose beneath the table says "Six mechanisms are marked 'to build.'" Fix the prose — or the table — as part of this work so the registry counts itself correctly.

  Serves the JSDoc and no-npm-dependency halves of **TL-3D5K**, whose proposed means (a linter) the same ruling forecloses.

- **[ENG-8V3N]** Real Codex Silent-Prime hook support, if still wanted
  `effort: M · impact: S · area: engines · source: janitor · added: 2026-08-20 · status: open · stage: idea · refs: data/engines/codex.json, lib/engines.js#syncEngineHooks, lib/engines.js#_buildBaselineHooks`

  Train 5 (#982) shipped `codex.json`'s `capabilities.supportsSilentPrime: true` plus `data/hooks/sessionstart-prime-codex.sh`/`sessionstart-rules-codex.sh`, but `syncEngineHooks()` early-returns (clearing hooks) for any engine that isn't `'claude'` before ever reaching `_buildBaselineHooks()` — so the feature was never actually reachable for a real Codex project, and worse, `public/ui.js`/`lib/projects.js` read `supportsSilentPrime` generically to enable a UI toggle, so an operator could enable "Silent Prime" for Codex and it would silently do nothing. Found and fixed (capability turned off, dead scripts removed, doc/test updated) during a 2026-08-20 forensic review of the Antigravity commit window (issue #990). If real Codex hook support is still wanted: `syncEngineHooks()` needs a real non-claude code path (not just the current clear-and-return), and the mechanism should be redesigned against Codex's actual config format — this repo's `codex.json` declares `.codex.yaml` as the config format, not TOML, which the original Train 5 work assumed incorrectly. Out of scope for the #990 review fix; this is new feature work.

## Promoted

- **[MED-2K9P]** Medusa session-comms control in the TC session banner (switchboard realization)
  `effort: L · impact: L · area: ui/integration · source: user · added: 2026-07-09 · reviewed: 2026-07-10 · status: promoted · stage: ready · refs: .prawduct/artifacts/med-2k9p-session-comms-discovery.md, .prawduct/artifacts/build-plan.md`

  A Medusa logo/toggle in the TC session banner that turns per-session send/receive on/off (register workspace + start listener), glows/animates when actively communicating with another session, and on hover shows basic swarm/Medusa stats (peers, workspace status, recent-msg count from `:3009/telemetry` + `/workspaces`).

  Includes **inbound reach-back**: another session/Medusa can message THIS live session and it surfaces in the UI — likely via a TC-server-side per-session listener on the workspace inbox that injects a notification, mirroring the wrap-sentinel pattern.

  This is the TC realization of the **switchboard vision** (Medusa replaces the tmux send-keys hack for session-to-session comms).

  **Dependency cleared for v1 (2026-07-10).** The Medusa delivery prerequisite is NO LONGER blocking. Live dogfood on 2026-07-10 (Medusa v1.0.0-rc) confirmed direct-to-workspace delivery, offline store-and-forward queueing, AND WS reconnect-drain all work; issues #31/#25/#26 are fixed in code (commit d07cb01, left open for release sign-off). v1 (badge-receive) is buildable now against the current contract. **v2 (auto-inject) remains gated on Medusa#33 (at-least-once delivery)** — that gates v2 only, not this ready-to-build v1.

  Needs discovery + plan + Critic (new feature, not a quick UI add).

  **2026-07-09 — stage advanced design → ready.** Build plan authored and set active at `.prawduct/artifacts/build-plan.md` (switchboard v1, 4 chunks). Requirements Confidence High; operator accepted the two HIGH assumptions (in-server WS listener; A2A_SECRET refuse-if-unset). Ready to build — v1 dependency cleared 2026-07-10 (see above).

## Archive

- **[PRW-5N8T]** prawduct-hook test-evidence undercounts passed/total on suites with nested describes (upstream prawduct bug)
  `effort: S · impact: M · area: prawduct-upstream · source: builder · added: 2026-07-15 · reviewed: 2026-08-20 · status: shipped · stage: idea · refs: https://github.com/brookstalley/prawduct/issues/128 · closed-by: prawduct-3.4.0`

  **Filed upstream 2026-07-17** as brookstalley/prawduct#128 (https://github.com/brookstalley/prawduct/issues/128) with full root cause + repro. Nothing further to do TC-side (this item exists here only because no PRAWDUCT_BUG_INBOX is configured); keep open until the upstream fix ships in a plugin release TC picks up, then archive.

  **Upstream prawduct defect, not a TangleClaw bug** — captured here because no PRAWDUCT_BUG_INBOX is configured on this machine (`prawduct-hook bug-inbox` exits 1). Also reportable at https://github.com/brookstalley/prawduct/issues.

  **Symptom:** `prawduct-hook test-evidence record` writes `passed: 2143` for a run that actually executed **4237** tests — a ~2x undercount. `.test-evidence.json` therefore misstates the size of every recorded run in this repo.

  **Root cause (VERIFIED, 2026-07-15):** the hook sums the `tests=` attribute of the top-level `<testsuite>` elements in the junit XML (351 of them, summing to 2144 = 2143 passed + 1 skipped). But node:test's junit reporter sets `tests=` to a suite's **direct child element count** — and when a suite contains nested `describe` blocks, those direct children are the *sub-suites*, not the tests inside them. Example from this repo's XML: suite `antigravity engine (#456)` declares `tests="5"` (its 5 child describes) while containing **14** actual leaf testcases. The undercount scales with nesting depth.

  **Not a reporter difference.** Both reporters agree: `grep -c '<testcase'` on the junit XML = 4237, an ElementTree walk finds 4237 leaves / 0 wrappers, and the default reporter prints `# tests 4237`. The XML is complete and correct; only the aggregation is wrong.

  **Impact:** `failed` and `skipped` are accurate, and the gate reads `failed`, so nothing currently mis-gates — this is an audit-record integrity bug, not a correctness gate bug. But it is actively misleading: a Critic review of this repo (2026-07-15) flagged the 2133-vs-4225 spread as suspected stale evidence and hedged it 'may partly be a junit-vs-default reporter difference'. It was neither, and diagnosing it cost a real review cycle. Any repo whose tests nest describes will keep re-litigating this.

  **Suggested fix:** count leaf `<testcase>` elements (`.//testcase` with no nested testcase), or recurse the testsuite tree, instead of summing only top-level `tests=` attributes.

  **Repro:** any node:test suite using nested `describe`, run via `node --test --test-reporter=junit --test-reporter-destination=<f> test/*.test.js`, then compare `prawduct-hook test-evidence record` output against `grep -c '<testcase' <f>`.

  **Archived 2026-08-20 (MG4 migration scrub — deliberately NOT migrated to GitHub Issues).** This item's own criterion ("keep open until the upstream fix ships in a plugin release TC picks up, then archive") is met: upstream brookstalley/prawduct#128 closed 2026-08-02 and the fix is live in the plugin TC runs (3.4.0). Owner fact-check at the scrub: `.prawduct/.test-evidence.json` records passed 6499 against a real suite of 6532 — no ~2x undercount. Archived at source rather than minted as a permanent GitHub issue number.

- **[PRJ-7C4V]** Extract projects.js pure read-helpers into a cycle-free leaf module (kill the require-cycle class)
  `effort: M · impact: M · area: projects · source: critic · added: 2026-07-17 · reviewed: 2026-08-09 · status: shipped · stage: ready · related: PRJ-8M2X · closed-by: fix-884-sync-reads`

  Extract the pure read-helpers in `lib/projects.js` (`_readChangelogVersion`, `_readVersionJsonVersion`, `_readPackageJsonVersion`, etc.) into a leaf module with no requires back into the projects/store graph, so the recurring require-cycle class dies structurally instead of per-incident. Evidence the class recurs: #360 and #584, with four lazy-require workarounds accumulated so far — each new consumer of these helpers risks re-creating the cycle and adding a fifth. Type: refactor. Source: Chunk 01 cumulative Critic review.

- **[SEC-3H8W]** Lexical-only project containment lets a symlink escape the project root
  `effort: M · impact: S · area: security · source: critic · added: 2026-07-19 · reviewed: 2026-07-19 · status: shipped · stage: ready · closed-by: wrap-v2`

  `resolveWithinProject` in `lib/project-paths.js` checks containment lexically, so a symlink *inside* the project root that points outside it still passes — the resolved path stays under the root textually while the write lands elsewhere. Affects the `versionFilePath` setting validation and the version-bump write site that consume it.

  Low practical risk: the setting is operator-supplied on a single-tenant server, and the operator can already write anywhere they can reach. But the stated protection is arbitrary-file-write prevention, and a symlink defeats it — so the guard doesn't do what it claims.

  Fix direction: realpath-based containment. Needs care because the target may not exist yet (a version file being created for the first time), so the check likely has to realpath the deepest *existing* ancestor and validate the remaining lexical tail against it. Type: bug.

- **[WRP-2Q6H]** Strip legacy V1 NL-prompt wrap path (triggerWrap branch)
  `effort: M · impact: M · area: wrap · source: janitor · added: 2026-07-09 · reviewed: 2026-07-18 · status: shipped · stage: idea · closed-by: prawduct-v2-sunset`

  The legacy V1 NL-prompt wrap path (`lib/sessions.js` ~1174-1242 + the shim in `lib/skills.js` `synthesizeLegacyWrap`/`getWrapSkill`) is many release cycles past its documented "strip after one release cycle" window (`wrapV2` default-true since #196). Strip the legacy `triggerWrap` branch. **CAVEAT:** `skills.js#getWrapSkill` is also consumed by `lib/eval-audit.js` `scoreWrapQuality`, so `skills.js` can't be deleted wholesale — scope carefully.

- **[ART-7W2J]** regen-views blocked by MED-2K9P change-log↔roster mismatches (12 validation errors, no views written)
  `effort: S · impact: M · area: artifacts · source: builder · added: 2026-07-17 · reviewed: 2026-07-17 · status: shipped · stage: ready · related: ART-4K9M, MED-2K9P, PRW-9K4C · closed-by: session-2026-07-17`

  `prawduct-hook regen-views` fails with 12 validation errors and writes no views — all derived views blocked until fixed. Two mismatches: (1) `med-2k9p-v2` change-log entries tag chunks T1/T2/T3, but `med-2k9p-v2-build-plan.md`'s `## Status` roster is empty (no chunk checkboxes); (2) a `med-2k9p` v1 entry tags `chunks=02-followup`, absent from the v1 roster [01, 02, 03, 04]. Same rot family as ART-4K9M but in the MED-2K9P scopes.

  **Fix:** reconcile the v2 plan roster (add T1–T3 checkboxes) and re-tag or roster the `02-followup` id, then re-run regen-views clean.

  **⚠ Reconcile against ART-4K9M's resolution first (surfaced 2026-07-17 by an agent running the VRF-wrp-9f2k regen-views check, same day ART-4K9M shipped via PR #586 claiming regen-views exited 0 with 1 warning):** ART-4K9M's notes say (a) validation became non-fatal warnings under prawduct 2.1.5 — so "no views written" may indicate a regression or a different failure mode; (b) the v2 plan's roster is DELIBERATELY hand-set in `M1 —` format and invisible to regen (M-chunks have no TC change-log entries; reformatting would un-tick them forever — see the NOTE in the plan file). Confirm the live state and honor those NOTEs before editing rosters.

  **Shipped 2026-07-17 (session-2026-07-17, resolved locally — no PR; both edited files are gitignored under `.prawduct/artifacts/`).** 12 errors → 1. (1) `med-2k9p-v2` plan frontmatter scope nulled (documented author opt-out): the plan leaves the scope map and its 10 shipped entries become tolerated planless-shipped — roster untouched per the ART-4K9M NOTE, which was updated in place with the rationale. (2) v1 roster gained a "Chunk 02-followup" checkbox recording the real shipped follow-up. Remaining 1 error is `auth-5n2j` (release-pending planless — transient, self-clears when the next wrap flips it shipped); its recurring class is the upstream defect tracked as PRW-9K4C. Root cause was NOT new rot: prawduct 2.1.5→3.0.5 made regen-views validation fail-closed (upstream VWS-6R4T), turning the ART-4K9M-ratified tolerated-warnings into fatal errors.

- **[AUTH-5N2J]** authStatus chip false-positives configured-no-identity on direct-loopback dashboard loads
  `effort: S · impact: S · area: auth · source: janitor · added: 2026-07-09 · status: shipped · stage: ready · related: AUTH-2K9D · refs: docs/auth-status-surfacing.md · reviewed: 2026-07-17 · closed-by: auth-5n2j`

  The dashboard `authStatus` chip reports configured-no-identity (amber warning) on ANY direct-loopback dashboard load (e.g. `localhost:3102` bypassing caddy) even though caddy auth is healthy, because a loopback request carries no `X-Auth-User`. For the intended through-caddy access path it's correct; the loopback false-positive is a minor edge. Consider distinguishing "request didn't traverse caddy" from "caddy configured but not forwarding identity." Surfaced 2026-07-09 during the AUTH-2K9D VRF.

  Discovery resolved 2026-07-17: proxy-evidence split decided — `X-Forwarded-For` present → configured-no-identity (existing amber); absent → new configured-bypassed state, chip stays silent. Fix built on `fix/auth-5n2j-bypass-status`, PR pending.

  **Shipped 2026-07-17 (scope auth-5n2j):** fix built + Critic-reviewed on `fix/auth-5n2j-bypass-status`; archived on the branch so this rides in the closing PR.

- **[DOC-3K7Q]** FEATURES.md line-number pointers systematically stale; features-toc wrap step never re-verifies them
  `effort: M · impact: H · area: docs · source: janitor · added: 2026-07-09 · reviewed: 2026-07-17 · status: shipped · stage: ready · closed-by: doc-3k7q`

  Line-number pointers in FEATURES.md are off by hundreds (e.g. `GET /api/projects` cited `server.js:855`, actually `:1333`) because the features-toc wrap step refreshes the skeleton but never re-verifies line numbers. Fix: change the wrap step to emit **symbol names instead of `:line` pointers**. Also (same pass): prune the ~30 stale unfilled "TBD" auto-stubs, de-dupe same-day auto-stub headings, and correct FEATURES.md under-reporting shipped methodologies (only lists Prawduct; also ships `minimal` + `tilt`).

  **Shipped 2026-07-17 (scope doc-3k7q):** symbol-anchor rewrite + stub fold-in + citation contract test. Janitor's original wrap-step diagnosis corrected in discovery — the features-toc step never emitted line refs; the hand-authoring convention was the rot source.

- **[CI-2V8Q]** Make the Tests check required via branch protection
  `effort: S · impact: M · area: ci · source: builder · added: 2026-07-17 · reviewed: 2026-07-17 · status: shipped · stage: ready · related: CI-9F3T · closed-by: ci-2v8q`

  Now that CI-9F3T's workflow is live and green on main (PR #589), flip main's branch protection to require the `test` check. Deliberately deferred from CI-9F3T: it changes `gh pr merge --auto` semantics (auto-merge starts genuinely waiting for CI instead of merging instantly) and is an operator-visible workflow change. One-time `gh api` or Settings → Branches edit; verify with a trivial PR that auto-merge waits for the check.

  **Shipped 2026-07-17:** applied via `gh api` (required_status_checks contexts=`["test"]`, strict=false, enforce_admins stays off). Live-verified on PR #590: auto-merge armed, PR sat OPEN until the 54s `test` check passed, then merged server-side.

- **[CI-9F3T]** Add GitHub Actions CI running the test suite on PRs
  `effort: M · impact: M · area: ci · source: janitor · added: 2026-07-09 · status: shipped · stage: ready · reviewed: 2026-07-17 · closed-by: ci-9f3t`

  No CI: `.github/` has only issue templates; nothing runs the ~1920-test suite on push/PR. Add a GitHub Actions workflow running `node --test test/*.test.js` on PRs (Node 22), with a status badge in README — real value for a public repo.

  **2026-07-17 — discovery settled; ready to build.** Node 22 single-version pin (matches prod v22.22.x; `node:sqlite` floor). Triggers: `pull_request` + push-to-main. Suite verified headless-safe: 4315 tests / ~28s local, platform calls all mocked, git-using tests set their own `user.email`. Required-check branch protection deferred to a follow-up after the first green run on main.

- **[WRP-9F2K]** version-bump wrap step flips change-log status=merged→shipped when it promotes [Unreleased]
  `effort: S · impact: M · area: wrap · source: user · added: 2026-07-17 · reviewed: 2026-07-17 · status: shipped · stage: ready · related: ART-4K9M · closed-by: PR #587 (merged 2026-07-17, squash eb77f01)`

  The merged→shipped flip in `.prawduct/change-log.md` is a manual release-checklist convention (precedent 2f3adbf, and the v4.19.1 release commit 960c133); nothing mechanical performs it, which is how 29 entries rotted at `status=merged` across ~15 releases until the ART-4K9M back-stamp (2026-07-17, PR #586). CHANGELOG.md's `[Unreleased]` promote and the change-log status flip change state at the same moment for the same reason, so the version-bump wrap step (`lib/wrap-steps/version-bump.js`) should do both. Note prawduct itself has the merge-time stamp mechanical (stamp-merged, v2.1.1) but no release-time counterpart — a TC wrap step is where it lives today; if prawduct later ships a stamp-shipped, the wrap step can delegate. Until built, the safety net is regen-views' release-pending warning + the scope/status convention in change-log.md's header.

  **Design settled 2026-07-17 (operator-approved build this session).** Expected behavior:
  - When `lib/wrap-steps/version-bump.js` promotes `[Unreleased]` into a new version section during a wrap, it ALSO flips every `<!-- prawduct: ... status=merged ... -->` tag line in that project's `.prawduct/change-log.md` to `status=shipped` — **blanket, not per-release-scoped** (promote means everything merged is in the release; matches the manual convention 2f3adbf/960c133).
  - Step output reports the flipped count.
  - Statusless tagged entries are NOT flipped (they're a missed-merge-stamp diagnostic), but their count is surfaced in the step output.
  - No `[Unreleased]` promote → no flip.
  - Project has no `.prawduct/change-log.md` → clean no-op.
  - A flip failure must not fail the version-bump step (warn in output).
  - Does NOT run regen-views (prawduct's tool; the next regen picks the flips up). Supersedes the earlier sketch above, which had the wrap step running regen-views itself.

  **Shipped 2026-07-17 via PR #587 (squash eb77f01), same session it was filed.** Built exactly to the settled design: pure `_flipMergedTagLines` + `_stagePrawductChangeLogStamp` in `lib/wrap-steps/version-bump.js`, staged as a third single-transaction entry (never a direct write), gated after the drift guard so only a real promote stamps; statusless tag lines preserved as the missed-stamp diagnostic; failures degrade to `changeLogWarning` under the never-blocks contract; commit body gains a "Stamped N..." line. 10 tests, revert-verified (4 pins). Critic cumulative 0 blocking / 1 warning (stale test evidence — resolved by recording at HEAD). Deployed: server restarted onto da01966. Live confirmation rides VRF-wrp-9f2k-release-stamp (next wrap-driven release).

- **[ART-4K9M]** regen-views is fully blocked: change-log entries tag chunk ids absent from their build plan's ## Status roster
  `effort: M · impact: M · area: artifacts · source: builder · added: 2026-07-14 · reviewed: 2026-07-17 · status: shipped · stage: ready · related: MED-2K9P · closed-by: PR #586 (merged 2026-07-17, squash f1e783f)`

  `prawduct-hook regen-views` writes NO views — it fails validation with 23 errors, so with `views_enabled: true` every derived view (Status, release-notes, scope_rollups) is frozen at whatever was last written.

  **Pre-existing:** measured at 26 errors on the pre-MED-7Q4C tree (2026-07-14), i.e. not introduced by that fix — it dropped to 23 only because MED-7Q4C flipped two stale `status=branch` tags.

  **Root cause:** `scope=med-2k9p-v2` entries reference `med-2k9p-v2-build-plan.md`, whose `## Status` roster is now EMPTY because the plan was completed/archived after Slice 1 — so chunk ids (T1, T2, MED-7Q4C, 557, 560, 561...) can never flip a checkbox. A second, older instance: a v1 entry tags `chunks=02-followup`, which was never in `med-2k9p-v1-build-plan.md`'s roster [01, 02, 03, 04].

  Related: the session briefing's standing "completed build plan (strategy set, no active chunks) — consider resetting to defaults" advisory.

  **Needs a decision on the contract:** should post-plan fixes (backlog items, GH-issue fixes) carry a scope that maps to no roster at all, rather than borrowing the shipped plan's scope? Fix likely = reconcile the tags AND settle that convention, else the same drift recurs on the next archived plan.

  **Diagnostic lead (2026-07-15, found while shipping MED-6V3R — not fixed, scope-guarded).** Error count is now **25**, and **10 of them share ONE root cause**: `med-2k9p-v2-build-plan.md`'s `## Status` roster parses as `(empty — no chunk checkboxes in ## Status)` even though it visibly contains `- [x] M1 — …`, `- [x] M2 — …` etc. Fixing that single roster would clear ~40% of the backlog blocking regen-views in one edit. Concrete diff against a roster that DOES parse: `med-2k9p-v1-build-plan.md` reports roster `[01, 02, 03, 04]` and puts its `- [x] Chunk 01: …` checkboxes **immediately** after `## Status` (heading → blank → checkboxes). The v2 plan inserts a prose line (`Medusa side (tracked via Medusa issues; built by the builder session):`) between the heading and its first checkbox. Two candidate causes, not yet distinguished: (a) the parser reads only a contiguous checkbox block directly under the heading and stops at the first prose line; (b) the parser requires the literal `Chunk NN:` id format and does not recognize v2's `M1 — ` / `T3 — ` style. The error text 'no chunk checkboxes' (zero found, rather than found-with-wrong-ids) points at (a), but that is inference — confirm before fixing. Whoever picks this up: start by moving the prose line below the checkboxes in the v2 plan and re-running `prawduct-hook regen-views`; if the count drops 25→15, it is (a). MED-6V3R's own entry (`chunks=MED-6V3R | scope=med-2k9p-v2`) is one of the 10, as are 566/561/560/557/T1-T4 — every sibling in the scope errors identically, so this is not per-entry tag rot.

  **RESOLVED 2026-07-17 via PR #586 (squash f1e783f).** The filed hard-block (25 validation errors, regen-views writes NO views) no longer exists under prawduct 2.1.5 — validation is non-fatal warnings now. The 2026-07-15 diagnostic lead's hypothesis (a) (prose-line stops the parser) was WRONG; root cause was (b): `CHUNK_LINE_RE` requires the literal `- [x] Chunk <id>:` format, so the v2 plan's `M1 — `/`T1 — ` roster is invisible to regen (confirmed in plugin source, `lib/views.py`). Real underlying rot: 29 change-log entries stuck at `status=merged` though released (v4.5.0–v4.19.0) — regen only flips checkboxes from `status=shipped`, so it un-ticked v1's genuinely shipped chunks and warned on 15 phantom scopes. Fix: back-stamped all 29 (each verified against released CHANGELOG sections; wrap-583 stays `merged`, genuinely pending), ratified the scope contract in change-log.md's header (active-plan work uses the plan's scope; post-plan fixes get their OWN scope, never borrowed from an archived plan), NOTEs added to both med-2k9p plan files (v1: boxes now derived, don't hand-set; v2: roster deliberately hand-set/invisible — M-chunks have no TC change-log entries, reformatting would un-tick them forever). Post-fix: regen-views idempotent, exit 0, 1 accurate warning, scope rollups 7→23 scopes.

- **[UI-8W3D]** Reload/close during Select mode strands a session-level tmux mouse override (was `mouse off` on desktop; post-#580 also `mouse on` on mobile)
  `effort: S · impact: S · area: ui · source: critic · added: 2026-07-16 · reviewed: 2026-07-16 · status: shipped · stage: ready · related: UI-6M4V, UI-2P7T, GH#574, GH#580 · closed-by: PR #582 (merged 2026-07-16, squash 1394c6d)`

  Reloading or closing the session page while Select mode is active strands a session-level tmux mouse override — the Select-mode exit path never runs, so the override persists on the tmux session after the page is gone. Needs a **timer-free** restore (no-UI-timers rule): e.g. a `pagehide`/`beforeunload` restore, or — better — unsetting the session-level override on exit instead of pinning one on every round-trip. See the sibling Critic NOTE that every Select round-trip pins an explicit session-level override, eroding the no-override=inherits-global diagnostic model — one design (unset-on-exit rather than pin-opposite) can resolve both. Type: bug. Source: Critic NOTE on UI-6M4V (fix/574-iphone-terminal-input).

  **2026-07-16 — NOT resolved by UI-2P7T (PR #580, squash 978a271).** That chunk's unset-on-exit mechanism only runs on an explicit Done tap; a reload/close mid-select still strands the enter-set override (now `mouse on` on mobile / `mouse off` on desktop). The #580/#579 source-tracking (`getMouseState` explicit flag) is the building block this fix should reuse.

  **Shipped 2026-07-16 via PR #582 (squash 1394c6d).** The abandonment window is closed via a localStorage intent marker + repair-on-return replaying the #579 unset-when-inherited restore. Documented accepted edge: a second tab reloading while the first is mid-select repairs under it (rare; strictly better than stranding forever). Live confirmation rides VRF-2p7t leg 6.

- **[UI-2P7T]** iPhone paste affordance for the web terminal (GH #402), folding in the #579 select/restore residue fix
  `effort: M · impact: H · area: terminal-touch · source: user · added: 2026-07-16 · reviewed: 2026-07-16 · status: shipped · stage: ready · related: UI-6M4V, UI-8W3D, GH#402, GH#579, GH#192, GH#574 · closed-by: PR #580 (merged 2026-07-16, squash 978a271)`

  #574 just shipped tap-to-focus, which unblocks the design: a **Paste pill mirroring the Copy pill** — gesture-scoped `navigator.clipboard.readText()` → `term.paste()`, respecting #192 bracketed-paste. iOS clipboard reads must happen inside a real user gesture, hence the pill.

  **Folds in GH #579:** Select/Done strands a benign session-level `mouse on` because the restore path can't distinguish an inherited value from an explicit one — fix shape: `getMouse` reports the *source* of the value, and the exit path uses `set -u` (unset-on-exit) instead of pinning an explicit override. #579 touches the same select/restore code path as the paste work, so one chunk should cover both.

  Sibling residue bug **UI-8W3D** (reload/close during Select strands a session-level `mouse off` on desktop) lives on the same code path; its noted design direction (unset-on-exit rather than pin-opposite) is the same shape as the #579 fix — consider whether this chunk resolves it too.

  Operator-confirmed as next work 2026-07-16 after the VRF-574 on-device pass.

  **Shipped 2026-07-16 via PR #580.** UI-8W3D is **NOT** resolved by this chunk and stays open — the unset-on-exit mechanism only runs on an explicit Done tap; a reload/close mid-select still strands the enter-set override (now `mouse on` on mobile / `mouse off` on desktop). The #579 source-tracking (getMouseState explicit flag) is the building block a UI-8W3D fix should reuse.

- **[UI-6M4V]** iPhone Safari terminal is select-only — soft keyboard never appears, touch-scroll dead (GH #574; absorbs #439)
  `effort: M · impact: L · area: ui · source: user · added: 2026-07-16 · reviewed: 2026-07-16 · status: shipped · stage: ready · related: UI-9J3F, UI-4C7R, TST-6L2P, GH#402, GH#438, GH#431 · refs: GH#574, GH#439 · closed-by: fix/574-iphone-terminal-input (Fixes #574, Fixes #439)`

  On iPhone Safari the web terminal is effectively read-only (reported live by the operator 2026-07-16): the soft keyboard never pops up on any tap/gesture, touch-scroll does nothing (the standing #439), and the only working interaction is text selection. Operator's read: a regression introduced by the select fixes. Type: bug.

  **Blocks the VRF queue:** VRF-561 leg 6 and VRF-6V3R leg 4 are both iPhone-only legs — they are BLOCKED by this, not merely pending; do not drain them until fixed.

  **Scope:** supersedes/absorbs GH #439 (touch-scroll; likely same root). Related: GH #402 (iOS paste), GH #438 (toolbar Copy), GH #431 closed (⌥+drag copy, PR #432 — in the suspected blast radius).

  **Suspected cause (hypothesis, UNCONFIRMED — diagnose before patching):** `toggleSelect` (`public/session.js` ~2441) drives tmux mouse mode opposite ways on mobile vs desktop (`isMobile ? true : false` on enter), and tmux-mouse-on capturing pointer events could be what swallows the shim's scroll. Keyboard half likely separate: xterm.js raises the iOS keyboard only when its hidden textarea gets focus from a real user gesture — a `user-select`/`preventDefault`/overlay from the selection work may be eating that tap. Two failures may or may not share one cause. Prior art from #431: the confident first theory was wrong; test a falsifiable prediction first.

  **Fix alongside:** `toggleSelect`'s 30s `selectTimer` auto-revert violates the no-UI-timers rule (feedback_no_ui_timers; #98/#268) — remove/guard it, never lengthen.

  **Must ship with a test strategy, not just a patch** (operator explicitly asked for better tests): no iOS/touch harness exists; at minimum extract the touch/selection/focus decisions into pure functions executed in tests (the `new Function` lift per TST-6L2P). Desktop-passing evidence never covers iOS.

  Repro: open `https://cursatory.tail123678.ts.net:8443/session/<Project>` in iPhone Safari → tap terminal (no keyboard) → finger-scroll (nothing) → drag-select (works).

- **[MED-6V3R]** maxWallTimeSeconds default (600s) is tuned for autonomous runaway protection but is hostile to supervised loops, which park waiting on a human
  `effort: S · impact: M · area: ui/integration · source: user · added: 2026-07-15 · reviewed: 2026-07-15 · status: shipped · stage: idea · related: MED-8H5W, MED-2K9P, Medusa#57 · closed-by: fix/med-6v3r-mode-aware-wall-clock`

  The loop wall-clock guard defaults to **600s** (`DEFAULT_MAX_WALL_SECONDS`, lib/medusa.js) and counts from loop creation regardless of mode. That default is correct for **autonomous** mode, where the guard's job is to stop a runaway. It is actively wrong for **supervised** mode, where the loop is *designed* to park in `responded` waiting for a human to judge — so the guard reliably kills the loop while it is doing exactly what it is supposed to do (waiting), and nothing has gone wrong at all.

  **Evidence (2026-07-15, live):** the VRF-561 fixture guard-halted THREE times in one session purely because the operator stepped away — 930min (at the 600s default), then twice more at a hand-raised 1800s. Zero of those halts indicated a problem; all three were the operator having a life. Each halt destroys the fixture and forces a full re-open + re-reply cycle. A supervised loop **structurally cannot run away** — only the initiator can advance it, the target has no way to self-continue — so the wall clock protects against nothing in that mode.

  **Note:** `_guardInt` (lib/medusa.js:312) accepts any positive integer with no upper bound, so a long clock is already expressible — the problem is purely the default and the fact that one default serves two modes with opposite needs.

  **Shape (needs a decision, not yet buildable):** options include (a) a mode-aware default — generous or absent for `supervised`, tight for `autonomous`; (b) stop the wall clock while a loop sits in `responded` (i.e. measure *agent* time, not human wait time — arguably the honest semantics, since the guard means 'this loop is consuming resources unattended'); (c) leave the default and surface a clear affordance in the loop setup modal explaining the tradeoff. Option (b) is the most principled but changes guard semantics upstream in the Bridge (Medusa), so it likely needs coordination there rather than a TC-side fix. Related: Medusa#54 (the count-from-creation bug, already fixed) established that the counting basis is a real design surface.

  **RESOLVED 2026-07-15** → shipped option (a) mode-aware default + the honest half of (c) (a mode-specific hint naming what the clock actually bounds). Option (b) — stop the clock while a supervised loop waits — remains the principled fix and is **NOT shipped**: enforcement lives in the Bridge (`checkWallTimeGuardForLoop`), which this session cannot commit to under the cross-session write boundary, so it is filed upstream as a Medusa issue and linked here. Verified while building that Medusa#54 does **not** already cover this: #54 moved the clock's origin off loop creation to first delivery, but the clock still runs unpaused while a loop waits, so a supervised loop still expires on human deliberation. (a) makes the default humane; only (b) makes the guard measure the right thing.

  Option (b) is filed upstream as **Medusa#57** (https://github.com/Jason-Vaughan/Medusa/issues/57) — "Supervised loops expire on the human they are waiting for". If Medusa adopts the pause-the-clock or exempt-supervised fix, TC's supervised 8h default becomes redundant and can be retired.

- **[MED-7Q4C]** medusa-wake idleness judgment and nudge injection can resolve different tmux sessions
  `effort: S · impact: S · area: medusa-wake · source: critic · added: 2026-07-11 · reviewed: 2026-07-14 · status: shipped · stage: ready · related: MED-2K9P · closed-by: fix/med-7q4c-inject-judged-session`

  medusa-wake judges idleness on `session.tmuxSession` but injects via `injectCommand(project.name)`, which re-resolves the active session — identical under today's one-session-per-project model, but divergent if a project ever holds >1 live session (nudge could land in a different pane than the one judged idle). Latent, not currently reachable (Critic NOTE on T2, 2026-07-11). Fix shape: an `injectCommand` variant addressing an explicit tmux session, or assert the resolved session id matches before sending.

- **[UI-7H4K]** Wrap-drawer select widgets (pr-check, plan-picker) use standalone labels with no for/id association — a11y sweep
  `effort: S · impact: S · area: ui · source: critic · added: 2026-07-09 · reviewed: 2026-07-09 · status: shipped · stage: idea · closed-by: #523`

  The wrap-drawer select widgets (pr-check, plan-picker) render standalone labels with no `for`/`id` association to their controls, so screen readers can't tie the label to the select. Do an a11y sweep to associate them.

- **[WRP-6C4M]** Reconcile the commit/drawer 'no parseable chunks' defensive path after #515 made that staged shape unreachable
  `effort: S · impact: S · area: wrap · source: critic · added: 2026-07-09 · reviewed: 2026-07-09 · status: shipped · stage: idea · closed-by: #522`

  #515 made the staged shape that triggered the commit/drawer "no parseable chunks" defensive path unreachable. Reconcile that now-dead defensive branch — either remove it or re-establish which inputs (if any) can still reach it — so the code doesn't carry an unreachable guard that misleads future readers.

- **[UI-3B8N]** landing.js confirmWrap has the same re-entrancy defect fixed in session.js — apply in-flight guard + button lock
  `effort: S · impact: M · area: ui · source: critic · added: 2026-07-09 · reviewed: 2026-07-09 · status: shipped · stage: idea`

  `landing.js` `confirmWrap` (the dashboard wrap trigger) has the same re-entrancy defect already fixed in `session.js`: a double-click can fire concurrent wraps. Apply the same fix — an in-flight guard plus a button lock — so a second click while a wrap is in progress is a no-op.

- **[SR-5T1J]** Version-history pruning/retention for session_rule_versions
  `effort: M · impact: S · area: session-rules · source: critic · added: 2026-06-16 · reviewed: 2026-07-08 · status: shipped · stage: idea · refs: docs/session-rules-self-improvement.md · closed-by: #511`

  Deferred from the D1b cumulative Critic NOTEs (scope: tc-4.0). Watch-item, not yet actionable: unbounded `session_rule_versions` growth. Fine for a single operator today. Trigger to act = AI autonomy generating high edit volume, at which point a pruning/retention policy is warranted. References #347 / D1b. **Brought closer by CC-6 (#381):** the new wrap-time self-critique loop (AI-proposed `kind='wrap'` rules) is exactly the autonomy-volume trigger named here — revisit if wrap-rule promotion becomes frequent.

- **[CON-8H3Z]** Dedup the path-token regex shared by continuity Map and features-toc
  `effort: S · impact: S · area: continuity · source: critic · added: 2026-06-17 · reviewed: 2026-07-08 · status: shipped · stage: idea · closed-by: #509`

  `MAP_PATH_TOKEN_RE` in `lib/continuity.js` is character-identical to `PATH_TOKEN_RE` in `lib/wrap-steps/features-toc.js` (and the extension allowlists must stay in sync). Deliberate copy today; extract to a shared util if a future extension addition risks drift. Watch-item (a missed Map stub is recoverable under the never-blocks contract), not yet actionable. Surfaced by CC-3 Critic.

- **[AUTH-2K9D]** authEnabled can be true with no enforcing gate in direct mode — surface the config-vs-live mismatch
  `effort: S · impact: M · area: auth · source: critic · added: 2026-06-25 · reviewed: 2026-07-08 · status: shipped · stage: ready · refs: docs/auth-status-surfacing.md · closed-by: #508`

  Critic NOTE on AUTH-2 slice 2b. `/api/setup/complete` + `PATCH /api/config` let `authEnabled=true` persist in direct mode (settable-but-inert per slice 2a). Inert today (only the caddy cutover reads `authEnabled`), but config then claims auth-on with no gate. Consider a Settings indicator / `GET /api/config` signal that auth is configured-but-not-live until a caddy cutover. Non-blocking.

  **Folded in (AUTH-3 Critic NOTE, 2026-06-28):** the same "configured-but-not-live" gap shows up in AUTH-3 as an *undetectable broken identity flow* — when `authEnabled && ingressMode==='caddy'` yet `currentUser` stays null (e.g. a hand-edited live Caddyfile missing the `header_up X-Auth-User` line), nothing distinguishes "gate not configured" from "`header_up` missing." Fix idea: have `/api/server-info` hint that auth is on but no identity is arriving (`authConfigured && currentUser===null`), so the same Settings/UI signal covers both the AUTH-2 inert-config case and the AUTH-3 missing-header case.

- **[SR-7K2P]** Record Critic-gate-passage provenance on AI/autonomous session-rule edits
  `effort: M · impact: L · area: session-rules · source: critic · added: 2026-06-16 · reviewed: 2026-07-08 · status: shipped · stage: ready · refs: docs/session-rules-self-improvement.md · closed-by: #507`

  Deferred from the D1b cumulative Critic NOTEs (scope: tc-4.0). HIGHEST priority of the four.

  Make "was this edit actually gated?" explicit rather than only inferable from history + the activity log. E.g. a `critic_reviewed` flag captured on the session-rule version snapshot, so an AI/autonomous edit carries proof it passed the Critic gate. References #347 / D1b.

- **[SR-3MW8]** CHECK constraint on session_rule_versions.op enum
  `effort: S · impact: S · area: data-model · source: critic · added: 2026-06-16 · reviewed: 2026-07-08 · status: shipped · stage: ready · closed-by: #504`

  Deferred from the D1b cumulative Critic NOTEs (scope: tc-4.0). Cheap integrity win: add a CHECK constraint restricting `session_rule_versions.op` to the enum `('create'|'update'|'delete'|'restore')`. Fold into the next migration that already touches the table — no standalone migration needed. References #347 / D1b.

- **[AUTH-7P3M]** Wizard admin step: disabled Next gives no inline reason for an invalid password
  `effort: S · impact: M · area: auth · source: user · added: 2026-06-26 · reviewed: 2026-07-06 · status: shipped · stage: ready · refs: #498 · closed-by: #499`

  Found during AUTH-2 slice 2b live HITL smoke on elkaholic 2026-06-26. On the Admin Login step, when the password fails a rule (e.g. 11 chars, contains username, mismatch), the Next button is correctly disabled — but there's no inline feedback, so the operator can't tell WHY (user hit this with an 11-char password and was stuck). The `setupAdminError` div is only populated by `wizardAdminNext()`, which never fires while the button is disabled. Add live on-input validation hints (e.g. show "at least 12 characters" / "passwords do not match" / "must not contain username" under the field as the user types). Small UX polish; client-side only. Consider folding into slice 4.

  **Expected behavior (ratified 2026-07-06):** As the operator types in any of the three Admin Login fields, a live hint under the fields names the FIRST unmet rule, in the same order the Next-button gate checks them: "Enter a username." → "Password must be at least 12 characters." → "Passwords do not match." → "Password must not contain the username." The hint clears (and Next enables) when all client-side rules pass, and is suppressed while all three fields are still empty (no scolding before input). The rule set lives in ONE pure function consumed by the gate, the live hint, and the wizardAdminNext error path (symmetric-gates: one rule source, three surfaces). Server stays authoritative for the weak-password denylist via the existing setupAdminError path. Client-side only; setup.js is not SW-precached so no CACHE_NAME bump.

- **[ENG-5R2W]** Injected AI-guide API base URL says https:// but live server serves plain HTTP behind caddy
  `effort: S · impact: M · area: engines/config-injection · source: builder · added: 2026-07-06 · reviewed: 2026-07-06 · status: shipped · stage: ready · related: AUTH-2K9D · refs: #496 · closed-by: #497`

  The injected AI-guide API base URL says `https://localhost:3102`, but the live cursatory server serves plain HTTP on 3102 (caddy owns TLS since the ingress work). A session following the guide gets HTTP 000 on every curl until it falls back — a restart POST during the 2026-07-06 session (CAD-7X4V restart verification) silently no-oped against https:// and the stale server kept running until server-info exposed it. Fix: the base-URL injection should reflect the live scheme — probe once at config-generation time, or derive from `ingressMode`/https config. Type: bug.

- **[CAD-7X4V]** Extract shared adoption-computation helper for caddy dry-run/real paths
  `effort: S · impact: M · area: caddy · source: critic · added: 2026-07-04 · reviewed: 2026-07-06 · status: shipped · stage: ready · refs: #494 · closed-by: #495`

  PR-reviewer note on #476: `applyDryRunAdoptionPreview` (`scripts/ingress-cutover.js`) is a 3-concern hand-maintained mirror of `adoptCredentialIntoConfig` (`lib/caddy.js`) — credential + remote-HTTP + tailnet adoption duplicated across two files. The original dry-run/real divergence was itself a Critic-caught bug, and each future adoption shape adds another mirror obligation. Proposed: extract a shared pure helper that computes adoption on an in-memory config; the real path persists + logs. Type: refactor, small. Source: independent PR review (fable) on `fix/caddy-tailnet-adoption`, 2026-07-04.

- **[DOC-6W2R]** Doc-parity audit: data-model.md and api-contracts.md missing every post-v3.0 subsystem
  `effort: M · impact: M · area: data-model · source: critic · added: 2026-07-06 · reviewed: 2026-07-06 · status: shipped · stage: ready · related: SR-9QX4 · refs: data-model.md, api-contracts.md`

  `data-model.md` documents only 5 of ~19 tables — missing: `project_groups`, `project_group_members`, `shared_documents`, `document_locks`, `openclaw_connections`, `eval_baselines`/`eval_exchanges`/`eval_incidents`/`eval_scores`, and a `schema_version` note — and its per-project config sample lacks `silentPrime`/`featureIndexEnabled`/`projectMapEnabled`/`orchestration_profile`-adjacent fields. `api-contracts.md` is missing the Groups, Shared-Docs, OpenClaw connections/tunnels, Continuity/History, Master, Audit-ingest, Update/Restart, Server-info, and Session-Rules-adjacent (learnings) endpoint families.

  Surfaced while shipping SR-9QX4, which closed the session_rules slice only (scope discipline). Suggest slicing by subsystem when picked.

  **Slice 1 DONE (2026-07-06):** `openclaw_connections` documented as data-model.md §4.8 (DDL, column table incl. #160/#352/#483/#459/#296 semantics, migration lineage v5-v16, PortHub lease-coupling note, `store.openclawConnections` API) + api-contracts.md new §12 "OpenClaw Connection Endpoints" (all 12 routes: CRUD, version, detect-instance-dir, test, tunnel CRUD, approve-pending) + summary-table rows; sections renumbered 12→13→14. Live-verified: version/tunnel/test shapes exercised against the running server; write paths (auto-allocate create, PUT lease reconciliation, delete release) live-verified earlier same day during #489-#490 work.

  **Slice 2 DONE (2026-07-06):** groups + shared-docs + locks documented. data-model.md §4.9 `project_groups` + `project_group_members` (DDL, sharedDir v3→v4 lineage, `store.projectGroups` API), §4.10 `shared_documents` (DDL incl. the schema's only CHECK constraint on `inject_mode`, column table, `store.sharedDocs` API incl. `syncFromDirectory` + `getInjectableForProject`), §4.11 `document_locks` (TTL-30min advisory-lock semantics, expired-eviction on acquire, `releaseBySession` wrap path, `store.documentLocks` API). api-contracts.md new §13 Group Endpoints (9 routes) + §14 Shared Document Endpoints (8 routes incl. lock CRUD); summary rows added; renumbered 15/16. Live-verified: groups list/get enrichment (memberCount/docCount/members/docs), docs list/get + lock key, and the FULL lock cycle (acquire shape → 409 LOCK_CONFLICT on second acquire → release) against the running server.

  **Slice 3 DONE (2026-07-06):** eval audit family documented. data-model.md §4.12 (all 4 tables' DDL with the scored-state enum 0/1/2/3, JSON-in-TEXT columns called out, v8→v9 + v9→v10 lineage, 4 store-API method tables) referencing docs/eval-audit-mode.md as the narrative doc; api-contracts.md new §15 Eval Audit Endpoints (all 15 routes incl. the ingest Bearer-audit_secret auth model, required-field contract, and the three 201 response shapes scored/sampling-skipped/cost-cap-skipped) + summary rows; renumbered 16/17. Live-verified: telemetry/summary/baseline/incidents envelopes + ingest 401 auth gate + heartbeat 400 validation against the running server.

  **Slice 4 DONE (2026-07-06, final):** api-contracts.md §16 Continuity (4 routes), §17 Server/Update/Master (7 routes), §18 Global Rules/Service Token/Sidecar (7 routes), post-v3.0 compact contracts appended to §2 Projects (7 routes: import/archive/unarchive/actions/migrate-to-plugin/orphan-hooks×2) and §3 Sessions (wrap-complete, wrap-sentinel-ack), §9b ports/sync + setup https-check/generate-cert, full summary-table rows, renumbered 19/20; data-model.md §4.1 projects table un-staled (migration_status v17, orchestration_profile v22), §5 config sample + Field Reference gained silentPrime/featureIndexEnabled/projectMapEnabled/versionBumpEnabled/wrapAutoPrEnabled/orchestrationKeyRef/evalAuditMode.

  **Shipped (2026-07-06):** completed across 4 slices, all local-artifact updates (no PR; artifacts gitignored per #485). FINAL VERIFICATION: mechanical registry diff — 115/115 registered routes documented, 17/17 CREATE TABLE tables documented; slice-4 read endpoints live-exercised (server-info/master/update-status/models/rules/service-token-404/continuity sessions+drill-down/sidecar-404). Doc parity between code and the canonical artifacts is now complete.

- **[OUI-4T9M]** OpenClaw connection card omits the Bridge Port row
  `effort: S · impact: S · area: openclaw-ui · source: user · added: 2026-07-06 · reviewed: 2026-07-06 · status: shipped · stage: ready · related: OUI-2F8K · closed-by: #492`

  The expanded connection card (landing page) lists HOST/PORT/SSH USER/SSH KEY/CLI COMMAND/LOCAL PORT/VERSION but not the bridge port, so an allocated bridge port (e.g. via the #489 auto affordance, shipped as OUI-2F8K/#490) is only visible by opening the Edit modal. Surfaced during the VRF-489-bridge-auto operator smoke test (2026-07-06): the operator couldn't tell whether auto-allocation had worked from the card. Add a BRIDGE PORT row, shown only when set, to avoid noise on non-ClawBridge connections. Filed effort XS (below S on the S/M/L scale).

  **Shipped (2026-07-06):** closed by #492.

- **[SR-9QX4]** Doc-parity: add session_rules + session_rule_versions tables and /api/session-rules routes to the canonical docs
  `effort: S · impact: M · area: data-model · source: critic · added: 2026-06-16 · reviewed: 2026-07-06 · status: shipped · stage: ready · related: DOC-6W2R · refs: data-model.md, api-contracts.md, docs/session-rules-self-improvement.md`

  Deferred from the D1b cumulative Critic NOTEs (scope: tc-4.0). Doc-parity gap inherited from D1a: the `session_rules` and `session_rule_versions` tables, plus the `/api/session-rules` routes, exist (or are specced) but are not reflected in `data-model.md` and `api-contracts.md`. Bring the canonical docs into parity. References #347 / D1b. **Widened by CC-6 (#381):** add the `session_rules.kind` column (schema v20) + the `?kind=` query param / `kind` body field on the routes, and the per-project `wrapSections` config field. CC-6 shipped its own canonical spec (`.prawduct/artifacts/cc-6-project-rules-modal.md`) so this stays a NOTE.

  **Shipped (2026-07-06):** local-artifact update, no PR — `data-model.md` + `api-contracts.md` live in gitignored `.prawduct/artifacts/` per #485's tracking split. Delivered: data-model.md new 4.6 `session_rules` + 4.7 `session_rule_versions` (DDL, column tables, `store.sessionRules` API table, migration lineage v18/v19/v20), 4 `session_rule.*` rows in the Event Types table, `wrapSections` in the section-5 config sample + Field Reference (CC-6/CC-8 precedence chain); api-contracts.md new "11. Session Rules Endpoints" (all 8 routes with request/response contracts) + summary-table rows + fixed the duplicate `## 11` numbering (now 11/12/13). Verified: field shapes cross-checked against `_rowToSessionRule`/`_rowToSessionRuleVersion` and live-exercised (create/versions/conflicts/delete) against the running v4.4.1 server. Remainder gap → DOC-6W2R.

- **[OUI-2F8K]** Bridge-port auto-allocation UI affordance for OpenClaw connections
  `effort: S · impact: S · area: openclaw-ui · source: critic · added: 2026-06-17 · reviewed: 2026-07-04 · status: shipped · stage: ready · related: PH-4B7N · closed-by: #490`

  The API supports `bridgePort:"auto"` (free-port allocation from `[3201,3300)`) but the connection form has no way to request it — the Bridge Port field is blank=null only. Add an opt-in control (e.g. an "auto" toggle/button) so ClawBridge users can get a non-colliding bridge port without hand-picking. Surfaced by #352.

  **Shipped (2026-07-04):** closed by #490.

- **[PH-4B7N]** PUT/update lease reconciliation for OpenClaw connections
  `effort: S · impact: M · area: porthub · source: critic · added: 2026-06-17 · reviewed: 2026-07-04 · status: shipped · stage: ready · closed-by: PR #484 (issue #483, squash 64f4454)`

  When a connection's `local_port` or `bridge_port` changes via `PUT /api/openclaw/connections/:id`, the old port lease under `oc-direct-<id>` lingers until DELETE. On update, release the old lease and lease the new port. Surfaced by #352 (create-flow lease-at-create covers POST only).

  **Shipped (2026-07-04):** merged via PR #484 (issue #483), squash commit 64f4454.

- **[UI-9J3F]** Extract terminal-helper math (touch-scroll accumulator + #445 selection math) into pure functions for true unit tests
  `effort: M · impact: M · area: ui · source: critic · added: 2026-07-02 · reviewed: 2026-07-03 · status: shipped · stage: ready · related: UI-4C7R · closed-by: refactor/ui-9j3f-pure-terminal-math`

  Pull the accumulator/batching math (line quantization, wheel-delta sign) out of `tcWireTerminalTouchScroll` in `public/api-helper.js` into a pure function so it gets true unit tests instead of regex-on-source coverage. Source: cumulative-Critic NOTE on `fix/terminal-touch-scroll-ios` (2026-07-02).

  **Widened (2026-07-02, #445 Critic):** also cover `tcWireTerminalDragCopy`'s selection math — the `applySelection` length formula, the anchor swap, and `cellFromTouch`'s clamp + viewportY mapping — extracting each into pure functions with real unit tests. Regex-on-source coverage would miss an off-by-one in any of these. Source: cumulative-Critic notes on #445.

  **Shipped (2026-07-03):** delivered on `refactor/ui-9j3f-pure-terminal-math` — `tcQuantizeScrollDelta` + `tcCellFromPoint` + `tcSelectionSpan` pure functions in `public/api-helper.js` with `test/terminal-math.test.js` (18 behavioral tests); wiring delegates, behavior preserved; -0 API wart caught and normalized.

- **[UI-4C7R]** Extract a shared terminal theme-injection helper (touch-scroll shim + ⌥+drag copy override DONE)
  `effort: S · impact: M · area: ui · source: critic · added: 2026-07-01 · reviewed: 2026-07-03 · status: shipped · stage: ready · closed-by: chunk G slice 3 (#331)`

  Do before/with chunk G slice 3. `session.js` holds the originals and `ui.js` (master pane) now carries thin duplicates (`MASTER_XTERM_THEMES`, `wireMasterTouchScroll`), including the #431 ⌥+drag copy override — two copies of the same terminal-enhancement logic. Chunk G slice 3's in-session drawer is the natural third consumer and the extraction point: pull the shared helper out then, before a third copy lands. Source: cumulative-Critic NOTE on `feat/g-project-master-2` (2026-07-02).

  **Update (2026-07-02):** the touch-scroll piece is DELIVERED as the shared `tcWireTerminalTouchScroll` in `public/api-helper.js` (#443, branch `fix/terminal-touch-scroll-ios`). Source: cumulative-Critic notes on #443.

  **Update (2026-07-02, #445 Critic):** the #431 ⌥+drag copy-override piece is now also largely DELIVERED as the shared `tcWireTerminalDragCopy` in `public/api-helper.js` (#445). Remaining scope is **theme-injection extraction only** (`MASTER_XTERM_THEMES` / theme duplication between `session.js` and `ui.js`), still targeted at chunk G slice 3 as the landing point. Source: cumulative-Critic notes on #445.

  **Shipped (2026-07-03):** theme-injection extraction delivered in chunk G slice 3 (#331) — `TC_XTERM_THEMES` + `tcApplyTerminalTheme` + `tcEnableLocalSelectionOverride` + `tcWireTerminalFrame` in `public/api-helper.js`; all three terminal surfaces delegate.

- **[CON-1R6D]** Extract the duplicated recency/match-count/sid sort comparator + unindexed-meta builder in lib/continuity.js into one helper
  `effort: M · impact: M · area: continuity · source: builder · added: 2026-06-17 · status: shipped · reviewed: 2026-07-06 · stage: ready · related: CON-8H3Z · closed-by: #390`

  The recency/match-count/sid sort comparator (and the unindexed-meta builder) is duplicated across `listSessions`, `searchSessions`, and `searchProjectTranscripts` in `lib/continuity.js`. Extract the triplicated logic into one shared helper. Surfaced by CC-5 PR #379 review NOTE (comparator triplication), scope: tc-4.0.
