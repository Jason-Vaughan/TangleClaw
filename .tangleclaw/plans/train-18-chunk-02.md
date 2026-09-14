# Train 18 — Chunk 02: session range & ownership

**Issues:** #1309, #1406, #1469 (cross-references #1450 for its `HEAD~10` first-wrap symptom only; the
per-step sentinel half of #1450 is Chunk 3)
**Branch:** `feat/train-18-chunk-2-session-range`
**Worktree:** `TC-a02` (touches `lib/`, `public/`, `server.js`; does not run in the live install)
**Critic mode:** cumulative
**Size:** large (schema migration, launch path, range resolver + three consumers, a new pipeline step,
commit staging, a drawer widget)
**Train blueprint:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Coordinator/.tangleclaw/plans/train-18-blueprint.md`
(Coordinator-owned) §1, §3, §5
**Authorized:** operator "GO" in the Builder pane, 2026-09-14. Worktree ruling: operator chose
"target the worktree" in the Builder pane, 2026-09-14.

---

## Confidence check

**Problem.** A wrap has no idea when its session started or where it worked.
1. *Range (#1309).* "This session" resolves to `<lastWrapSha>..HEAD`, which is everything since
   whichever wrap stamped last. On a first wrap it falls back to `main...HEAD`. The AI prompts say
   `HEAD~10..HEAD`, which is a third range. Other sessions' merged commits get attributed to this
   one: false `FEATURES.md` stubs, and changelog blocks on commits someone else made (#1450).
2. *Staging (#1406).* The commit step runs `git add -A`, so a co-resident session's or the
   operator's uncommitted work is committed under a "Session wrap" subject.
3. *Worktree (#1469).* The wrap reads and commits the registered checkout. A session whose pane
   works in a git worktree edits files there. Every gate that checks an edit reads the wrong tree,
   and the AI cannot write the tree the gate reads, so the wrap loops.

**Success.**
1. Launching a session records a **launch baseline**: HEAD sha, repo toplevel, and the dirty-path
   set, taken before TangleClaw writes anything for the launch.
2. Every step that measures "this session" uses one resolved scope. The base is the launch sha, or
   this project's `lastWrapSha` when that is a descendant of the launch sha. The walk uses
   `--first-parent`, so trunk syncs merged into the session's branch are ignored. The AI prompts are
   given that exact range instead of `HEAD~10`.
3. The commit stages an explicit path list: files the session changed, files the wrap wrote, and
   files the operator approved. Any other dirty file is listed in the drawer with a per-file
   Include / Leave choice. The wrap does not commit until each one is decided.
4. A wrap whose session pane works inside a worktree of the project's repo runs against that
   worktree (git reads, AI-edited files, capture file, commit). Project config stays in the
   registered checkout, and `lastWrapSha` is still stamped there.

**Out of scope.** The per-step sentinel and step-injection race (#1450 → Chunk 3); the popover UI and
delegated-remediation rows (Chunk 4); worktree *ownership* in general (#1332); #1280's subtraction of
wrap commits (already handled by `WRAP_SUBJECT_RE` where it matters, unchanged here).

**Requirements confidence: HIGH** for 1, 3 (blueprint §1 is explicit). **HIGH** for 4's direction
(operator ruling), **MEDIUM** for its edges (D7). **MEDIUM** for 2's merge rule (D4) — the blueprint says
"ignoring external merges" without defining one; D4 is the definition and it is vetoable.

---

## Decisions

**D1 — launch baseline.** New `sessions` columns `launch_sha`, `launch_toplevel`, `launch_dirty`
(JSON `{paths, truncated}`), migration v39. `lib/launch-baseline.js#capture(projectPath)` runs
`git rev-parse HEAD`, `--show-toplevel`, and `git status --porcelain -z --untracked-files=all`, each
bounded, and never throws. A non-repo, a failed probe, or a timeout gives a null baseline, and a log
line says which. The dirty set is capped at 5000 paths and marked `truncated` beyond that. It is
taken in both `launchSession` and `launchWebuiSession` **before** engine config generation. A file
TangleClaw regenerates at launch (the `CLAUDE.md` guide in #1469) is therefore not "dirty before
this session". Rows from before the migration have a null baseline and use the D3 fallbacks.

**D2 — one scope per run.** `lib/wrap-scope.js#resolve(project, session)` is computed once at the top
of `runWrapPipeline` and handed to every step as `context.scope`. It returns
`{workTree, configRoot, base: {sha, kind, stopped}, trunk, baseline, startedAtMs}`. Steps stop
resolving ranges themselves. `changelog-coverage`, `features-toc` and `continuity-write` take the
base from the scope. The shared `_git-range` keeps its sync/async twin structure: argv declared
once, and the policy is pure.

**D3 — the base.** Candidates are the launch sha (when it is a commit and an ancestor of the tip) and
`lastWrapSha` (same test). With both usable, take the descendant. With one, take that one. With
neither, fall back to today's trunk range (`kind: 'branch'`), logged. A killed probe is recorded in
`stopped`, as today (#897). `kind` gains `'launch'` beside `'session'` (lastWrapSha) and `'branch'`.

**D4 — first-parent and "external merges" (vetoable definition).** Commits are listed with
`git log --first-parent <base>..<tip>`. Non-merge commits count with their own files. For a merge
commit on that chain:
- It is an **external sync**, and ignored, when HEAD is not on the trunk *and* its second parent is
  an ancestor of `main`/`master` or `origin/main`/`origin/master`. That is a pull of trunk into the
  session's branch.
- Otherwise it counts, with its first-parent diff as its files. That is a PR merge on a trunk
  checkout, or a local feature merge.

Known limit, written into the docs: on a trunk checkout, another session's PR merge that landed after
launch still counts. Nothing local tells the two apart, and the launch bound is what keeps that small.

**D5 — ownership.** `lib/wrap-steps/_file-ownership.js#classify(scope, dirtyNow)` (named apart from the unrelated `lib/session-ownership.js`) sorts each dirty
path into owned or foreign.
- Baseline present for the same toplevel and not truncated:
  - A path in the launch dirty set is **foreign** (`dirty-at-launch`).
  - Anything else dirty is **owned**.
- No usable snapshot (worktree target, legacy row, or a truncated set): a path whose mtime is at or
  after session start is **owned**. An older path is **foreign** (`predates-launch`). A deletion is
  **foreign** (`unknown-deletion`), because there is no mtime to judge it by.
- Paths the wrap wrote this run are always owned: staged flushes, plus any watched output that
  changed during the run.

Known limit: a co-resident session's edit made *after* launch looks like this session's work. The
drawer copy says "changed since this session launched", not "yours".

**D6 — the decision step and explicit staging.** A new step `session-files` (kind `session-files`,
`blocker: true`) runs right after `preflight`. It blocks when any foreign path lacks a decision in
`options.pathDecisions` (`{[path]: 'include'|'leave'}`). The server honors decisions only for paths in
its own foreign set and ignores the rest. The commit step re-classifies, then stages
`owned ∪ wrap-written ∪ included` with `git add -A --pathspec-from-file=<tmpfile> --pathspec-file-nul`,
each entry `:(top,literal)`, and commits with the same pathspec so anything already staged stays out.
Never a bare `-A`. If a foreign path has appeared that nobody decided on, the commit blocks too
(defense in depth). "Anything to commit?" counts only stageable paths. `changelog-coverage`'s
uncommitted-work check judges only paths that will be committed.

**D7 — worktree target (operator ruling).** `wrap-scope` reads the session pane's cwd
(`tmux display -p -t <session> '#{pane_current_path}'`) and resolves its `--show-toplevel` and
`--git-common-dir`.
- When the common dir is the project repo's but the toplevel differs, `workTree` is that worktree
  (offset by the project's path inside its repo), and `configRoot` stays `project.path`.
- A pane outside the repo, an unreadable pane, or a session with no tmux leaves
  `workTree = project.path`, logged.

Steps get `context.project` with `path: workTree` and `configPath: configRoot`. All eleven
`store.projectConfig.load/save` sites in the wrap steps and pipeline read `configPath`. A source guard
fails when a wrap step reads config from `project.path`. The `session-files` row (the first step after
preflight) says "Wrapping worktree `<path>`" whenever the target differs; built there rather than on
`run-start`, which the drawer renders no line for. The continuity store is TangleClaw's machine state,
so it stays in the config root too; `priming-roll` reads `activePlan` from the config root.

Known limit, in the docs: gitignored local state the AI writes during the wrap (memory files) lands in
the worktree.

**D8 — the prompts.** `_interpolatePrompt` gains `{sessionScope}`: one sentence naming
`git log --oneline --first-parent <range>` over the range the checks resolve, plus `git status --short`.
The default `changelog-update` and `memory-update` prompts drop the `HEAD~10..HEAD` / `lastWrapSha`
advice and use it. A branch-fallback range says it may include earlier sessions; no range at all says so.

**D9 — the finalize path's sweep.** `completeWrap`'s `_autoCommitIfDirty` runs `git.commit`, which is
`git add -A`. It existed for the retired NL-prompt wrap ("the AI exited before its commit step"). It is
the same #1406 mechanism on the `/wrap/complete` route, so it is **removed**: finalize records the
wrap and commits nothing. The pipeline's commit step is the only wrap commit. Vetoable. The
alternative is routing it through D5, which needs a scope the route does not have.

---

## Build steps

- **02a** — Migration v39 + `lib/launch-baseline.js` + capture in both launch paths before config
  generation + store read/write. Tests: capture on repo / non-repo / truncated / killed probe; launch
  stamps the row; legacy row reads null.
- **02b** — `lib/wrap-scope.js` (base D3, first-parent walk D4, worktree target D7) and `_git-range`
  additions (sync + async twins over one argv set). The three range consumers take the scope. The
  config sites read `configPath`, with a source guard. Tests on real temp repos: launch vs
  lastWrapSha descendant choice, trunk-sync merge ignored on a branch, PR merge counted on trunk,
  worktree detected and offset, non-worktree pane ignored, killed-probe fallback. #1309's repro is
  six foreign files from pre-branch merges and must no longer stub.
- **02c** — `_session-ownership.js` (D5), the `session-files` step (D6), commit explicit staging,
  coverage filter, `_autoCommitIfDirty` removal (D9). Tests: a co-resident dirty-at-launch file is
  never committed without `include` (#1406 repro); `leave` keeps it dirty and uncommitted; a decision
  for an unlisted path is ignored; wrap-written paths are staged; a deletion is staged; the commit
  refuses an undecided foreign path; the #1469 repro on a real worktree no longer loops.
- **02d** — Drawer: `decisionWidgetForBlockedStep` case `session-files` (per-path Include / Leave,
  reason text), `collectOptionsFromAccessors` → `pathDecisions`, accumulated across retries like
  `skipAiContent`, and the worktree target line. Tests on the pure helpers and the session.js wiring
  vm test.
- **02e** — Prompts (D8). Docs: `api-contract.md` / `configuration-reference.md` (`pathDecisions`,
  scope, limits), `FEATURES.md` (the #1309 inline note gets the issue number), CHANGELOG
  `[Unreleased]`, `.prawduct/change-log.md`. Bookkeeping owed from #1483: archive
  `train-18-chunk-01.md`.
- **02f** — Live check on a scratch server (tailnet IP):
  - (1) A launch with a pre-existing dirty file shows it in the drawer; Leave → the commit excludes it.
  - (2) Commits from a trunk sync merged into the branch are not in the changelog range.
  - (3) A session pane in a worktree wraps against the worktree.

## Done when

Suite green; the 02f check observed; `/prawduct:critic cumulative` with no unresolved blocking
findings; PR opened (`Fixes #1309`, `Fixes #1406`, `Fixes #1469`, refs #1450); the Coordinator pinged
with the PR link.

## Status

- [ ] 02a launch baseline
- [ ] 02b scope + range + worktree target
- [ ] 02c ownership + explicit staging
- [ ] 02d drawer approval list
- [ ] 02e prompts + docs
- [ ] 02f live check
