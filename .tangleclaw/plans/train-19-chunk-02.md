# Train 19 — Chunk 02: release readiness signals (L1) and `releaseMode` (L4)

**Issue:** #1492 (layers L1 and L4 only; L3 drawer is Chunk 03, L2 AI recommendation is Chunk 04)
**Branch:** `feat/release-mode-1492`
**Worktree:** `.claude/worktrees/release-mode-1492` (the primary clone is the live install)
**Critic mode:** cumulative
**Size:** medium (one new module, the config reader, the settings API, the version-bump step, docs)
**Roadmap:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Coordinator/.tangleclaw/plans/master-roadmap.md`
(Coordinator-owned), Train 19
**Authorized:** operator "starting chunk O2. Go." in the Builder pane, 2026-09-14; the Coordinator
confirmed over the switchboard that O2 means Train 19 Chunk 02.

---

## Confidence check

**Problem.** The wrap's `version-bump` step answers "should this wrap cut a release?" with one boolean,
`versionBumpEnabled`. `true` cuts on every wrap that has `[Unreleased]` entries, including a mid-feature
save. `false` never cuts. It also means "this project versions itself", so an operator can't say
"hold unless I choose" without also saying "TangleClaw never versions this project".

**Success.**
1. A pure function takes readiness signals and returns `ready | not-ready | unknown`, plus each signal's
   state and a one-line reason. The same inputs give the same verdict on every engine.
2. A project has `releaseMode: off | auto | ask`.
   - `off`: the step never cuts. This is today's `versionBumpEnabled: false`.
   - `auto`: the step cuts only when the verdict is `ready`. It holds on `not-ready` or `unknown`, and
     the skip reason names the signal responsible.
   - `ask`: the step never cuts by itself. It holds with `needsOperator: true` and the verdict, so the
     Chunk 03 drawer can render the decision.
   - In `auto` and `ask`, an explicit bump level from the wrap modal counts as the operator's decision
     and cuts, whatever the verdict.
3. Existing projects keep their behavior without any file being rewritten. `versionBumpEnabled: false`
   reads as `off`, and anything else reads as `auto`.
4. `PATCH /api/projects/:name` accepts `releaseMode`. The settings modal's legacy `versionBumpEnabled`
   checkbox keeps working until Chunk 03 replaces it, and it can't clobber `ask`.

**Out of scope.**
- The drawer's Release: Auto / Cut / Hold control and the `needs-operator` halt (L3, Chunk 03).
- The AI recommendation step (L2, Chunk 04).
- Any `public/` change. The drawer already renders a skipped step's reason.
- The "picker ignored when bumping is disabled" bug. `off` still skips before reading the bump level.
  See D6.
- Cutting v5.26.0 or changing this project's own setting.

**Requirements confidence: HIGH** for the mode semantics and migration (#1492 body; the Coordinator's
chunk scope). **MEDIUM** for the signal set (D4): the issue lists signals as examples, and two of them
don't fit a pure local gate. Both are vetoable.

---

## Decisions

**D1: explicit operator level beats the gate in `auto`/`ask`, not in `off`.** The wrap modal's picker
sends `bumpLevel` only when the operator picks one; "auto" sends nothing (`public/session.js`). An
operator who picks Minor has decided to cut. `off` means TangleClaw doesn't version the project at all,
and it is kept as-is (D6).

**D2: migrate on read, never rewrite project files.** `project.json` is tracked in many managed repos.
A bulk rewrite would drop an unexplained diff into every one of them. `resolveReleaseMode(config)`
returns the explicit `releaseMode` if it's valid, `off` if legacy `versionBumpEnabled === false`, and
`auto` otherwise. *Amended during the build:* a settings write keeps the legacy key in step
(`versionBumpEnabled` = mode is `auto`) rather than removing it. A TangleClaw rolled back to a version
that reads only the old key then holds instead of cutting, and the #318 persistence test stays true
as written.

**D3: `DEFAULT_PROJECT_CONFIG.releaseMode` is `null`.** A default of `'auto'` would be merged into
every loaded config and hide a legacy `versionBumpEnabled: false`, so the migration would silently cut
releases for projects that opted out. `null` means "derive". An unrecognised on-disk value (for example
a hand-typed `"Auto"`) resolves to `ask` with a warning. It fails closed without cutting, and without
silencing the step the way `off` would.

**D4: the L1 signal set for this chunk.**
- `unreleased-entries`: `[Unreleased]` has entries. It fails when the section is empty, and is
  `unknown` when there is no CHANGELOG or no section.
- `build-plan-status`: the active plan has every `## Status` box ticked. The plan is resolved the way
  Prawduct's template defines the pointer: relative to `.prawduct/`, with unset/null meaning
  `artifacts/build-plan.md`. *Amended:* the first draft read the pointer as project-root-relative with
  no fallback, and the template showed that was wrong. The signal is `n/a` with no project-state file,
  with no default plan behind an unset pointer, or with a plan that has no `## Status` section.
  *Amended:* a sweep of every local project found Monad-1's plan using per-chunk checklists (including
  a struck-out unticked item), which would have held its releases indefinitely. It is `unknown` for an
  explicit pointer to a missing file, a path outside the project, an unreadable file, or a Status
  section with no boxes, and it fails on any unticked Status box.
  The pointer is used rather than a glob over `artifacts/` because this repo alone keeps five stale
  plan files there, and a glob would hold every release.
- Aggregation: any `fail` gives `not-ready`, otherwise any `unknown` gives `unknown`, otherwise `ready`.
  `n/a` never counts.
- **Descoped, and said explicitly:** *tree clean.* A wrap commits the session's own work, so a dirty
  tree is the normal state and not a readiness signal. *Linked issue closed.* That needs the network and
  GitHub auth, so it isn't a pure local signal. Filed as a follow-up (see Status).

**D5: the legacy `versionBumpEnabled` alias on PATCH.** `false` sets `off`. `true` sets `auto` only
when the current mode is `off`, and leaves `auto`/`ask` alone, because the settings modal sends the
checkbox on every save. A PATCH with both keys that disagree (`false` + a non-`off` mode, or `true` +
`off`) is refused with 400. `enrichProject` reports both `releaseMode` and
`versionBumpEnabled = releaseMode !== 'off'`.

**D6: the picker-ignored bug stays separate.** #1492 says to fix it independently. With `ask`
available, the operator's actual intent for this project ("hold unless I pick") has a setting of its
own. Whether `off` should also honour an explicit pick is the bug's own decision.

**D7: engine-agnostic by construction.** Every signal is a file read under the project root. No engine
path, no subprocess, no network. The verdict is identical on every engine (project rule clause 4).

---

## Build steps

1. `lib/release-readiness.js`: `evaluateReleaseReadiness(signals)` (pure), `gatherReleaseSignals(projectPath, {changelog})`
   (fs only), and `readActiveBuildPlanPointer`. Tests in `test/release-readiness.test.js`.
2. `lib/project-config.js`: `RELEASE_MODES`, a `releaseMode: null` default, and `resolveReleaseMode`.
   Tests.
3. `lib/wrap-steps/version-bump.js`: the mode gate (off → skip; auto/ask → readiness; the explicit level
   wins). Update the skip-message remedies that name `versionBumpEnabled`. Tests.
4. `lib/projects.js`: the validator row for `releaseMode`, the D5 alias, persistence that keeps the
   legacy key in step, and `enrichProject` reporting. Tests.
5. Docs: `docs/configuration-reference.md`, `.prawduct/artifacts/data-model.md`,
   `.prawduct/artifacts/api-contract.md`, `docs/release-process.md` where it cites the flag, CHANGELOG,
   and the change-log entry.

## Done when

- The suite is green, and the new tests cover each mode × verdict and the migration.
- A live read against this repo's own config reports `releaseMode: off` (legacy false) with no file
  changed.
- Cumulative Critic: 0 blocking.
- PR opened. The Coordinator gets a chunk-close memo.

## Status

- [x] 02a L1 readiness module
- [x] 02b releaseMode resolver
- [x] 02c version-bump gate
- [x] 02d settings API + enrich
- [x] 02e docs + follow-up issue filed (linked-issue-closed signal: #1495)
