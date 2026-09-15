---
scope: bugfix-sprint-chunk-02
---

# Bugfix Sprint Chunk 02 — TangleClaw state leaves the files projects track

**Issues:** #1510 (move volatile state out of tracked files), #1511 (heal on launch), #1512 (one-time un-track offer)
**Program plan:** `.tangleclaw/plans/bugfix-sprint-wrap-noise.md`
**Branch / worktree:** `fix/1510-volatile-state-out-of-tracked` in `.claude/worktrees/bugfix-02-state-move`
**Size / type:** large bugfix (persisted format + launch path + wrap step + drawer). Critic mode: chunk per sub-chunk, cumulative before PR.
**Operator go:** "start chunk 02", Builder pane, 2026-09-15.
**partition:** 02a → 02b → 02c serial (each builds on the previous accessor). Chunks 03, 04, 05 delegated in parallel worktrees on the operator's ruling the same day; this chunk does not wait on them. Expected overlap: 03 may touch `commit.js`/`_file-ownership.js`, and 05 touches `public/wrap-drawer.js`/`public/session.js`, which 02c also touches. Integrate 02 first and rebase the others onto it.

## Operator ruling — scope narrowed from the program plan (recorded, not dropped)

The program plan said `medusa/registry.json` "and the other machine-state files move under the same untracked location". **Ruled 2026-09-15: move only `lastWrapSha`.**
- `lastWrapSha` must leave its file, because `project.json` is durable config that projects should keep tracking.
- Every other state file is state as a whole file, so untracking it (#1512) plus a local exclude (#1511) ends the churn where it is.
- Moving those files would break the `session-prime.md` path that engine hook scripts in other projects already use. It would also relocate the `continuity/` store. And a moved tracked file becomes a deletion nobody commits.

The persisted-format question "which workspace id does this checkout hold?" keeps its existing answer, `medusa/registry.json`.

## Confidence check

1. **Problem.** Every wrap rewrites `lastWrapSha` in the tracked `.tangleclaw/project.json`, so the file is dirty into every next session (20 projects). State files git still tracks (`medusa/registry.json` in 13 projects, and others) show as changed whenever TangleClaw writes them. Chunk 01 stopped the wrap *asking* about them, but they still churn in `git status` and never get cleaned up.
2. **Success.**
   - Two consecutive wraps leave `project.json` byte-identical.
   - A worktree wrap still finds the boundary through the registered checkout.
   - After one launch, TangleClaw's state paths are in `.git/info/exclude`, an old `lastWrapSha` is out of `project.json`, and the prime says so in one line. A second launch changes nothing, and no launch creates a commit.
   - A wrap in a project where state files are still tracked offers once to stop tracking exactly those paths. Approve untracks them in the wrap commit; Decline is remembered and not asked again.
3. **Out of scope.**
   - Moving any state file other than `lastWrapSha` (ruling above).
   - `.gitignore` edits: the exclude is local only.
   - Projects registered below their repository root: they get an honest skip for the exclude, and the Chunk 01 known limit stands.
   - Hands-off mode (#1485).
   - The Master's own home config.

## Evidence (read from the code this session)

- **Readers and writers of `lastWrapSha`** (`grep -rn lastWrapSha lib server.js`):
  - Writer: `commit.js#_stampLastWrapSha` (load → set → `store.projectConfig.save`).
  - One reader: `commit.js#_readLastWrapSha`, which reports `recorded | absent | unreadable` (#797) and is consumed by `wrap-scope.resolve` → `scope.lastWrapSha`/`lastWrapShaRead`.
  - Two fallbacks read `projConfig.lastWrapSha` directly when no scope exists: `features-toc.js` (~237) and `changelog-coverage.js` (~200).
  - `ai-content.js`, `continuity-write.js` and `_git-range.js` take the value as a parameter.
  - `project-config.js` `DEFAULT_PROJECT_CONFIG.lastWrapSha: null`.
  - `_tc-owned-paths.js` `VOLATILE_CONFIG_KEYS`.
  - No hit in `server.js`, `public/`, `bin/`. `test/` has 67 references across 11 files.
- **Saving `project.json`**:
  - `store.projectConfig.save` writes the whole merged object, so a loaded legacy `lastWrapSha` is written back by every save site (about 20 in `projects.js`, `server.js` and `store.js` migrations).
  - `load` merges the file over the defaults, so a key on disk survives a load even when the defaults drop it.
- **The launch path** (`sessions.launchSession`):
  - `launchBaseline.capture` runs first, then TangleClaw's writes: version record, prime file, rule shards, engine config, engine hooks, git hooks.
  - The prime is generated from `generatePrimePrompt(project, engineProfile, {...})` before those writes.
- **Where the exclude lives.** Git reads `info/exclude` from the common git dir, so a worktree shares it. `git rev-parse --git-path info/exclude` resolves the real file both in a checkout and in a worktree (whose `.git` is a file).
- **The operator-decision channel.** `session-files` blocks with `foreignPaths`, and `wrap-drawer.pathDecisionsWidget` renders Include/Leave, which ride back as `options.pathDecisions`. `needs-operator` + `releaseDecisionWidget` is the pattern for a single decision. `commit.js` re-classifies and stages only `stageable`.

## Design

### 02a — the state file and one accessor (#1510)

**New `lib/wrap-state.js`** manages TangleClaw's untracked per-checkout state at `.tangleclaw/state.json`. The relpath `STATE_RELPATH` goes in `lib/tangleclaw-project-files.js`, so Chunk 01's state registry matches it with no second literal.

```json
{ "schema": 1,
  "lastWrapSha": "<sha>|null", "lastWrapStampedAt": "<ISO>", "lastWrapStampedBy": "<TC version>",
  "migratedFromProjectConfigAt": "<ISO>|null",
  "untrackOffer": { "decision": "declined", "decidedAt": "<ISO>", "paths": ["..."] } | absent }
```

The questions this record answers:
- What is the last wrap boundary? → `lastWrapSha`.
- Which TangleClaw version stamped it, and when? → `lastWrapStampedBy`, `lastWrapStampedAt`.
- When was it migrated? → `migratedFromProjectConfigAt`.
- Was the un-track offer declined, and for which paths? → `untrackOffer`.
- Which workspace id does this checkout hold? → `medusa/registry.json`, unchanged.

- `schema` lets a later reader refuse a format it doesn't know rather than misread it. An unknown `schema` reads as `unreadable`.
- `readLastWrapSha(projectPath)` → `{sha, read: 'recorded'|'absent'|'unreadable'}`, the same contract `_readLastWrapSha` has today.
  - Reads `state.json` first.
  - With no state file, falls back to the legacy `project.json` key through a **raw** read, so a project not yet healed keeps its boundary. An unparseable `project.json` is `unreadable`, never `absent`, which keeps the #797 rule.
- `stampLastWrapSha(projectPath, sha, {version})` writes `state.json` atomically (tmp + rename) and **never touches `project.json`**.
- `adoptLegacyLastWrapSha(projectPath, legacySha)` records a legacy value only when `state.json` has no recorded sha. Idempotent.
- `migrateProjectConfig(projectPath)`:
  - raw-reads `project.json`; with no `lastWrapSha` key, returns `{migrated:false}` and writes nothing;
  - otherwise adopts the value, then removes only that key and rewrites the file in the same serialization `save` uses.
  - Unparseable JSON → `{migrated:false, reason}`, and nothing is written.
- `commit.js#_readLastWrapSha` / `_stampLastWrapSha` keep their names and callers and delegate to the accessor. `wrap-scope` is unchanged, since it already goes through `_readLastWrapSha`.
- The `features-toc` and `changelog-coverage` fallbacks call `wrapState.readLastWrapSha(configRootOf(project))` instead of `projConfig.lastWrapSha`.
- `project-config.js`: drop `lastWrapSha` from `DEFAULT_PROJECT_CONFIG`.
- `store.projectConfig.save`: when the object carries `lastWrapSha`, adopt it into state first, then omit it from what is written. Every save site becomes a migration and none can lose the boundary.
- `_tc-owned-paths.judgeProjectConfig`:
  - The `lastWrapSha`-only → `state` branch goes; it is dead once no writer puts the key in the file.
  - Removing `lastWrapSha` (present in HEAD, absent in the working copy) is a migration-owned difference, so maintenance.
  - Adding or changing `lastWrapSha` is **not** maintenance (null): no current writer does that.

### 02b — heal on launch (#1511)

**New `lib/project-heal.js`**, `healOnLaunch(projectPath, deps)`, returns `{report: string|null, migrated, exclude: 'added'|'current'|'skipped', excludeReason, trackedState: string[]}`. It never throws: every failure becomes a stated reason.

1. `wrapState.migrateProjectConfig(projectPath)`.
2. `git rev-parse --show-toplevel --show-prefix --git-path info/exclude`. On a non-zero exit → `exclude: 'skipped'` with "not a git repository" or git's own error. A non-empty prefix (a project below the repo root) → skipped with that reason.
3. Write a delimited block (`# BEGIN:tangleclaw-state` … `# END:tangleclaw-state`) into the exclude file, **replacing** an existing block and leaving every other line byte-identical. Result: `added`, `current` (no write), or `skipped` (write failed, with the reason).
4. `trackedState` = `git ls-files -z` filtered by `_tc-owned-paths.isStatePath`. It is reported; nothing is changed.

**Exclude patterns come from the same table as the matchers.** `_tc-owned-paths` gains `statePatterns()`: each registry entry declares `{label, pattern(s), matcher}` built from the writer's constant, so a pattern and its matcher can't drift. A test checks every pattern against its matcher on sample paths via `git check-ignore`.

**Wiring:** `launchSession` calls `healOnLaunch(project.path)` right after `launchBaseline.capture`. Anything heal writes counts as this session's, or as maintenance under Chunk 01's judge. The `report` goes into the prime as one line in the existing status area of `generatePrimePrompt` (via `options.healReport`), and only when something happened or something is still tracked. A no-op launch adds nothing.

- **No commit, ever.** Heal runs no git write command (`add`, `rm`, `commit`, `update-index`). Tests assert HEAD and the index are unchanged.
- [ASSUMPTION: once per launch, not on server start.] Heal runs where TangleClaw is about to use the project. Healing all projects at server start would rewrite 20+ `project.json` files with no session present to commit them. Veto → also run at startup.

### 02c — the one-time un-track offer (#1512)

In `session-files`, after `classify`:
- `trackedState` = tracked paths (`git ls-files -z`) that are state paths, minus paths already staged for removal.
- If it is non-empty, and `state.json` has no `untrackOffer` decline covering exactly these paths, and `options.untrackState` is absent → the step returns `needs-operator` with `output.untrackOffer = {paths}` and a remediation listing every path: "These TangleClaw state files are tracked by git, so they change in every session. Stop tracking them? This runs `git rm --cached` on exactly these paths in the wrap commit; the files stay on disk."
- `options.untrackState === 'approve'` → the output carries `untrackPaths`, and the `commit` step runs `git rm --cached -q -- <paths>` (argv, never a shell string) before staging. The paths are named in the commit body under a "Stopped tracking TangleClaw state" line.
- `'decline'` → `wrapState.recordUntrackDecline(paths)`. The step proceeds as today. A later wrap asks again only when a **new** tracked state path appears that the decline didn't cover.
- Ordering: the file-decision blocker (`foreignPaths`) takes precedence. The offer is asked once the Include/Leave choices are settled, so one Retry never carries two unrelated kinds of question.
- **Drawer:** a `untrackOfferWidget(stepRow, rawOutput)` beside `releaseDecisionWidget` renders the path list with "Stop tracking" / "Keep tracking". The choice rides back as `options.untrackState`, and the drawer's option sanitizer accepts only `approve|decline`. `public/session.js` wires it the way it wires the release widget.
- The server-side sanitizer for wrap options accepts `untrackState` only as `approve|decline`. Find where `pathDecisions` is sanitized on the route and mirror it.

**Contract surface:** `session-files` output gains `untrackOffer`; wrap options gain `untrackState`; the commit body gains a line. Consumers: `wrap-drawer.js`, `session.js`, `commit.js`, and the wrap route's option sanitizer. The Chunk 01 Include/Leave flow is unchanged.

## Tests (real git in temp repos; the store under `_setBasePath`; never the live store)

- `test/wrap-state.test.js`:
  - Reads: state recorded / absent; the legacy fallback; unreadable `state.json`; unknown schema; unparseable `project.json` during the fallback → `unreadable`.
  - A stamp never touches `project.json`, and **two stamps leave it byte-identical** (the #1510 acceptance).
  - Migration: idempotent; removes only `lastWrapSha`; adopts without overwriting a newer recorded sha.
  - `save` omits the key after adopting it.
- `test/wrap-session-scope.test.js` (existing) + a new case: a worktree wrap resolves the boundary from the registered checkout's `state.json`.
- `test/wrap-tc-owned-paths.test.js`:
  - `lastWrapSha` removal → maintenance; addition or change → null.
  - `state.json` is state.
  - Pattern ↔ matcher agreement via `git check-ignore`.
- `test/project-heal.test.js`:
  - First launch: migrates, adds the block, reports.
  - Second launch: no change to any file, report null.
  - A worktree resolves the common exclude.
  - Not a repository → skipped with a reason.
  - An existing operator exclude line is preserved.
  - A stale block is replaced.
  - HEAD and the index are unchanged.
  - A subdirectory project is skipped.
- `test/wrap-untrack-offer.test.js`:
  - A tracked state file → `needs-operator` with exact paths.
  - Approve → the commit removes them from the index, the files remain on disk, and the commit body names them.
  - Decline → remembered, with no offer next wrap; a new tracked path → offered again.
  - Foreign paths take precedence.
  - Multi-hop: session-files → commit on one tree.
- Drawer: a widget unit test in the existing wrap-drawer suite.
- The existing `lastWrapSha` tests (11 files) are updated only where they seed `project.json.lastWrapSha` **as the storage location**. A test that asserts behavior keeps its assertion. Any fixture moved to `state.json` is named in the change-log.

## Docs and bookkeeping

- CHANGELOG `[Unreleased]` `### Fixed`.
- FEATURES.md: the wrap and launch entries.
- `docs/configuration-reference.md` (the `project.json` keys: `lastWrapSha` removed, state file described).
- `.prawduct/artifacts/data-model.md` (the new persisted file).
- `architecture.md`, if it lists launch writes.
- `_config-root.js` JSDoc (it names `lastWrapSha` as `project.json` content).
- JSDoc on every new function.
- Check `docs/adr/0002-wrap-pipeline-contract.md` for the options vocabulary (`untrackState`).

## Known limits

- **A pre-upgrade TangleClaw on another clone of the same project** still stamps `lastWrapSha` into `project.json`. If that clone commits it, this clone's launch heal removes it again, and the key flips between clones until every clone runs this version. Each flip costs one maintenance commit, never a lost boundary: the reader prefers `state.json`.
- **A project registered below its repository root** is skipped for the exclude (the stated reason is logged). Chunk 01's known limit stands.

## Status

- [x] 02a — `wrap-state.js` accessor + readers moved + `save` migration + judge update, with tests; Critic chunk
  - Review `rev-20260915T212905Z-89b9c406`: 0 blocking, 3 warnings.
    - R-1 fixed: a changed-but-present `lastWrapSha` is state again, so upgraded projects are not asked.
    - R-2/R-4 fixed: an unreadable state file is never overwritten, and the key stays.
    - R-8 fixed: a temp file is cleaned up on a failed write.
    - The rest are accepted.
    - Fix commit `a85ae495` is re-covered by the 02b chunk review rather than a separate verify-resolutions round.
- [x] 02b — `project-heal.js` + exclude block + launch wiring + prime line, with tests; Critic chunk
  - Review `rev-20260915T214003Z-727705ea`: 1 blocking (R-1: nothing tested that a launch heals after the baseline) and 4 warnings.
  - All of them are fixed in the 02c commit, re-covered by 02c's review:
    - launch-order tests for the tmux and web UI paths, with the mutation check red when heal runs before the baseline;
    - R-2 (the prime promised the offer), which 02c builds;
    - R-4/R-6: an explicit `failed` flag on the migration, git run in the C locale, and problems logged by value.
  - R-7 is accepted as a known limit (below).
- [ ] 02c — un-track offer (session-files, commit, drawer widget, option sanitizers), with tests; Critic chunk
- [ ] 02d — docs, CHANGELOG, FEATURES.md; full suite; cumulative Critic; operator verification of the drawer offer from a remote browser; PR
