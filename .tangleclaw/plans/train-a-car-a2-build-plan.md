---
title: "Train A Car A2: updater ownership and authored-data preservation"
status: PLANNED — Architect decisions D1–D5 pending (held: Architect offline at plan-write, per the PM)
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (message 866e2043)
issues: [1537, 1730]
governed_by:
  - Architect roadmap, "Car A2 — updater ownership and authored-data preservation" (TangleClaw-Architect/.tangleclaw/plans/v5-v6-backlog-census-and-bridge-roadmap.md)
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION (not engaged: the updater moves TangleClaw's own checkout and reads no engine config beyond the existing CLAUDE.md carrier pin)
scope: train-a-car-a2
branch: feat/a2-chunk1-updater-ownership (Chunk 01); Chunk 02 gets its own branch and session
partition: serial. Both chunks change the same guard in lib/update-applier.js and the same beacon dialog
critic_mode: chunk (Chunk 01), cumulative at Chunk 02
---

# Train A Car A2: updater ownership and authored-data preservation

## Acceptance gate (from the train manifest)

Classify product-owned, generated and operator-authored paths explicitly. Never delete or
overwrite authored state. When reconciliation is required, produce one actionable blocked result.

## Confidence check

1. **Problem.** The dashboard updater deleted an uncommitted plan. Its dialog said "Nothing of
   yours is in this list", because `_classifyDirty` treats every path under `.tangleclaw/` as
   TangleClaw-written (#1537, 2026-09-16). An install that customised `data/global-rules.md`
   cannot update to any release that changes that file (#1730, reported by `GURULifeline`, hit
   four times). Without `skip-worktree`, the guard refuses with no way forward. With it, the
   guard passes and `git checkout <tag>` then aborts with a raw git error, a 500 `git-error` that
   never names the cause.
2. **Success.** In Chunk 01, an untracked or modified plan, priming prompt or memory under
   `.tangleclaw/` is real work, so the update refuses rather than deletes. Every entry the
   dialog offers to discard is **proven** TangleClaw's for its current delta, so "Nothing of
   yours" is true whenever it is shown. In Chunk 02, an install with local edits to
   `data/global-rules.md` updates, and its edits are still there afterwards. When the edits
   conflict with the release, the update refuses before anything moves, with one blocked result
   that names the file, says why and gives the steps. No update path ends in a raw
   `git checkout` error.
3. **Out of scope.** Moving operator rules out of the repo into an overlay file is rejected in
   D3. Filing it as an issue waits for the Architect's ruling. Also out: restart or provisioning
   changes (#1710), moving the runtime off the Builder checkout (#1672), and the wrap's
   ownership module beyond reusing one of its proofs.

## Facts established while planning (verified against code and git, 2026-09-22)

- The updater only ever moves **TangleClaw's own checkout** (`REPO_DIR`), never a managed project.
- In that checkout, `.gitignore` ignores `.tangleclaw/*` and re-includes only `plans/` and
  `priming/` (since #964, 2026-08-16). Every other TangleClaw write under `.tangleclaw/` is
  ignored, so `git status --porcelain` never lists it. **Today the `.tangleclaw/` prefix can
  only ever match authored content.** Narrowing it loses no real discard.
- `.claude/settings.json` is discardable by whole path, but the file is tracked (#833) and an
  operator can hand-edit it. The dialog's "Nothing of yours" is therefore false for that file
  as well, not just for plans. The wrap already proves the narrower claim ("only TangleClaw's
  own hook entries were removed") in `lib/wrap-steps/_tc-owned-paths.js#judgeHookSettings`.
- `git checkout <tag>` refuses to overwrite a skip-worktree or assume-unchanged file that the
  tag changes. It also refuses an untracked file that the tag adds. `git status --porcelain`
  shows neither, so the dirty guard cannot see them (#1730 repro).
- `store.globalRules.save()` (the landing-page editor) writes `data/global-rules.md` in place.
  Since #240, that tracked file is the one canonical source. The legacy per-install path
  `~/.tangleclaw/global-rules.md` is still detected and warned about, so no new file may use
  that name.

## Architectural decisions (for the Architect; each has a recommendation)

- **D1: Nothing under `.tangleclaw/` is discardable by the updater.** Drop the prefix from
  `_classifyDirty`. *Rejected:* an allow-list built from the wrap's `isStatePath` registry. That
  registry answers "never commit, never ask", which is a different question from "safe to
  delete". Some of its entries (the continuity and handoff stores) hold state the next session
  reads, and `.gitignore` already keeps all of it out of porcelain. So the allow-list would be
  unused code with the wrong meaning. Reusing it across that boundary is a bug.
- **D2: `.claude/settings.json` becomes a per-delta proof, not a whole-path pass.** It is
  discardable only when `judgeHookSettings` says the sole change from HEAD is TangleClaw
  removing its own hook entries. The proof is the one the wrap already uses, moved into or
  shared with `managed-block.js`-style pure code so the update path doesn't load the wrap
  pipeline. *Rejected:* leaving the file whole-path, which keeps the dialog's claim false for a
  hand edit. *Rejected:* making it real work outright, which would bring back the pre-#1022
  refusal on every project mid-migration.
- **D3: Operator edits to `data/global-rules.md` are carried across an update by a three-way
  merge that is computed before anything moves.** The inputs are base = `HEAD:file`, ours = the
  working copy and theirs = `<tag>:file`, merged with `git merge-file -p`. If the merge is
  clean, the updater backs up the working copy, restores the file, checks out the tag and writes
  the merged content back. If the merge conflicts, nothing is touched and the updater returns
  one blocked result (D4). *Rejected:* (a) an overlay file outside the repo, composed at read
  time. That changes a persisted format, reverses #240's single canonical source and changes
  what the landing-page editor does on the developer install, where editor edits are committed
  and shipped. It would also still need a one-time migration. (b) Managed-region markers, which
  split one editor document into two regions the editor cannot represent. (c) Detection and a
  message only, which blocks the reporter again on every release that touches the file. I'll
  file (a) as a follow-up issue if the Architect wants the layer eventually.
- **D4: API contract. There is a new refusal code, `reconcile-required` (409).** Its body is
  `{ reconcile: [{ path, reason, action }] }`, where `reason` ∈ `merge-conflict`,
  `skip-worktree`, `assume-unchanged` or `untracked-collision`, and `action` is a sentence the
  dialog shows as written. The preflight runs after fetch and before checkout. For each path
  that `git diff --name-only HEAD <tag>` names, it checks the flags from `git ls-files -v` and
  whether the path exists untracked. A skip-worktree flag on the carried file is handled by the
  merge: the flag is cleared only for the checkout and put back afterwards. If `checkout` still
  fails with git's "would be overwritten", the error maps to this code rather than to a 500
  `git-error`. *Rejected:* reusing `dirty-tree`, because its payload means "dirty in
  porcelain", and the beacon's discard branch would wrongly offer a discard. **ADR 0010
  applies.** The new code is a contract change for both consumers, the route and
  `scripts/apply-update.js`. It must reach the injected update prompt and every doc that lists
  the codes, and `test/update-prompt-guards.test.js` enforces that. Clause 3 of the ADR forbids
  raw git in any `action` text. The steps are therefore given as editor and dashboard actions,
  for example: "open Global Rules, copy your additions, then Update again".
- **D5: The carried set is one declared constant, `OPERATOR_AUTHORED_TRACKED =
  ['data/global-rules.md']`. Widening it is a ruling.** The backup goes to
  `<TANGLECLAW_HOME>/backups/global-rules.<fromSha7>-<toTag>.md` and is written before the file
  is restored. If the backup cannot be written, the update refuses.

Implementation details that fall outside these triggers are my own calls, recorded in each chunk.

## Chunks

### Chunk 01: The updater discards only what it can prove is TangleClaw's (#1537)

- `lib/update-applier.js`: replace the path test in `_classifyDirty` with an explicit table of
  three classes. **generated, proven per delta** covers `CLAUDE.md` (existing region proof) and
  `.claude/settings.json` (hook-retirement proof, D2). **operator-authored** covers everything
  under `.tangleclaw/` and `OPERATOR_AUTHORED_TRACKED`. **Real work** is everything else. The
  JSDoc's "THE LINE" paragraph is rewritten to state the new line and why.
- Move `judgeHookSettings` and its helpers to a shared pure module, or re-export them, so
  `update-applier` requires no wrap pipeline. The `isTcHook` predicate comes from the same
  place the wrap takes it.
- Tests (`test/update-applier.test.js`): an untracked `.tangleclaw/plans/x.md` is `realWork`. A
  modified tracked plan is `realWork`. `.tangleclaw/priming/` and `.tangleclaw/memories/` are
  `realWork`. `settings.json` is discardable when only a TangleClaw hook was removed and is
  `realWork` when the operator added a permission. An unparseable `settings.json` is
  `realWork`. The existing CLAUDE.md region cases stay green unchanged. One end-to-end case in
  a real temporary git repository: `applyUpdate({discardDirty:true})` with a dirty plan
  refuses, and the plan file still exists byte-for-byte.
- `public/update-beacon.js`: the dialog wording stays. It becomes true by construction, and a
  test pins that every discardable entry passed a per-delta proof. The realWork branch names
  `.tangleclaw/plans/` so the operator knows to commit the plan.
- Docs: the updater section of `docs/` (find the page that documents `discardDirty`) and
  `CHANGELOG.md` `### Fixed`.

**Done when:** the suite is green, the Critic (chunk) has run and every blocking finding is
resolved, and the carried-over edit that flips the A1 plan's frontmatter to COMPLETE is in
this PR.

### Chunk 02: Operator-edited global rules survive an update, or block it cleanly (#1730)

- A preflight after fetch and before checkout (D4), plus the three-way merge carry (D3) with
  its backup (D5), in `lib/update-applier.js`. Git is always called in argv form, and every
  step fails closed.
- `server.js`: `reconcile-required` → 409. The `api-contract.md` artifact documents the new code.
  Per ADR 0010, the code also has to reach `scripts/apply-update.js`, the injected update prompt
  and `docs/user-guide.md` and `docs/configuration-reference.md`, which list the codes.
- `public/update-beacon.js`: render `reconcile[]` as one blocked dialog listing path, reason and
  action. There is no discard button.
- Tests: a real temporary repository with two tags, where tag 2 changes `data/global-rules.md`.
  (a) A non-overlapping local edit updates and the edit survives. (b) A conflicting edit
  returns `reconcile-required` and HEAD, the file and its flags are unchanged. (c) The
  skip-worktree repro from #1730 gives the same outcomes as (a) and (b), and the flag is back
  afterwards. (d) An untracked file that the tag adds returns `reconcile-required` with
  `untracked-collision`. (e) A forced checkout failure maps to `reconcile-required`, not
  `git-error`. (f) A failed backup write refuses.
- Docs: remove or correct any published `skip-worktree` workaround, and add a CHANGELOG
  `### Fixed` entry with `Reported-by: GURULifeline` credit (#1730).

**Done when:** the suite is green, the cumulative Critic is clean, and the #1730 repro has been
run against a scratch clone from the issue's steps.

## Status

- [ ] Chunk 01 — updater discards only proven-TangleClaw deltas (#1537)
- [ ] Chunk 02 — global-rules carry-or-block (#1730)
