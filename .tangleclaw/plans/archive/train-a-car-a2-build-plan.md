---
title: "Train A Car A2: updater ownership and authored-data preservation"
status: COMPLETE — Chunk 01 shipped (#1800, #1537 closed); Chunk 02 in this PR (#1730, open until the operator closes it); Architect ruled D1–D10
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (message 866e2043)
issues: [1537, 1730]
governed_by:
  - Architect roadmap, "Car A2 — updater ownership and authored-data preservation" (TangleClaw-Architect/.tangleclaw/plans/v5-v6-backlog-census-and-bridge-roadmap.md)
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION (engaged, narrowly: the updater moves only TangleClaw's own checkout, whose tracked engine files are Claude's `CLAUDE.md` and `.claude/settings.json`. Both are proof entries pinned to the engine layer's own declarations, so no engine is required: another engine's files are simply real work)
scope: train-a-car-a2
branch: fix/a2-chunk2-global-rules-carry
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

## Architectural decisions (as proposed; the rulings below bind)

- **D1: Nothing under `.tangleclaw/` is discardable by the updater.** Drop the prefix from
  `_classifyDirty`. *Rejected:* an allow-list built from the wrap's `isStatePath` registry. That
  registry answers "never commit, never ask", which is a different question from "safe to
  delete". Some of its entries (the continuity and handoff stores) hold state the next session
  reads, and `.gitignore` already keeps all of it out of porcelain. So the allow-list would be
  unused code with the wrong meaning. Reusing it across that boundary is a bug.
- **D2: `.claude/settings.json` becomes a per-delta proof, not a whole-path pass.** It is
  discardable only when `judgeHookSettings` says the sole change from HEAD is TangleClaw
  removing its own hook entries. The proof is the one the wrap already uses. The update path
  loads it with a require at call time, as it already does for the engine layer, so a load
  failure costs that one proof and never the self-update module. *Rejected:* leaving the file whole-path, which keeps the dialog's claim false for a
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

### Architect rulings (2026-09-22, message a358b1ba) — binding

- **D1: ACCEPTED.** Where a path lives does not prove who owns it for a discard. Every
  `.tangleclaw/**` entry that porcelain shows is real work. Do not reuse the wrap's state
  registry.
- **D2: ACCEPTED.** `.claude/settings.json` is discardable only when its current delta passes
  `judgeHookSettings`. Every load, parse or proof failure fails closed as real work.
- **D3: MODIFIED.** The HEAD / working-copy / tag three-way carry is approved. The overlay,
  managed-region and detect-only alternatives are rejected. Binding conditions:
  (a) `data/global-rules.md` skips the generic dirty-tree refusal only to enter this carry path,
  and it is never discardable.
  (b) The merge is computed before anything changes, and a conflict changes neither the working
  tree's bytes nor any index flag.
  (c) The exact original bytes are preserved before anything changes.
  (d) If any later restore, checkout, flag or write step fails, the updater compensates back to
  the exact checkout and ref it started from, the original bytes and the original index flags
  before it returns. If that compensation fails, it reports the failure and where the backup is
  kept. It never claims a clean refusal or a success.
- **D4: MODIFIED.** The code is `409 reconcile-required`, returned in the normal result
  envelope: `{ok:false, code, error, fromSha, toRef:null, toSha:null, reconcile:[…]}`. Reasons
  are `merge-conflict`, `skip-worktree`, `assume-unchanged`, `untracked-collision`, and
  `checkout-collision` for a late overwrite that has been proven. Only a diagnosed overwrite or
  collision maps to this code; unrelated git failures stay `500 git-error`. The code is returned
  only after the starting state has been preserved or restored. There is no discard action and
  no raw-git action text. The contract must reach both ADR 0010 consumers, the prompt, the UI,
  the tests and every document that lists the codes.
- **D5: MODIFIED.** One `OPERATOR_AUTHORED_TRACKED` constant is approved, and widening it needs
  the Architect. The backup is local, private, atomic and immutable: mode `0600`, and never
  written over an earlier backup with the same fromSha and tag name. An existing file is reused
  only if its bytes are identical; otherwise the name gets a collision-safe digest or attempt
  suffix. If the backup cannot be secured, the update refuses before anything changes.
- Approving D1 and D2 settles the architecture only. Implementation and merge readiness still
  belong to the Critic and the PR reviewer. Re-escalate only if an assumption changes or a
  material conflict appears.

Implementation details that fall outside these triggers are my own calls, recorded in each chunk.

## Chunks

### Chunk 01: The updater discards only what it can prove is TangleClaw's (#1537)

- `lib/update-applier.js`: replace the path test in `_classifyDirty` with an explicit table of
  three classes. **generated, proven per delta** covers `CLAUDE.md` (existing region proof) and
  `.claude/settings.json` (hook-retirement proof, D2). **operator-authored** covers everything
  under `.tangleclaw/` and `OPERATOR_AUTHORED_TRACKED`. **Real work** is everything else. The
  JSDoc's "THE LINE" paragraph is rewritten to state the new line and why.
- One `PROOFS` table (path → proof) is the whole discardable set; the classifier and the proof
  router both read it. [DECISION: Chunk 01 has two classes in code, proven and real work.
  Operator-authored paths are real work by construction. The explicit
  `OPERATOR_AUTHORED_TRACKED` constant arrives in Chunk 02, where it first changes behaviour.]
  `HOOK_SETTINGS_FILE` is pinned to `engines.SHARED_HOOK_SETTINGS_PATHS` by a test.
- Load `judgeHookSettings` from `lib/wrap-steps/_tc-owned-paths.js` and
  `isTangleClawHookEntry` from `lib/engines.js` at call time, inside a fail-closed catch.
  [DECISION: kept in place and not moved. That module requires nothing heavy at load time, and
  a call-time require keeps the existing "update-applier loads without the engine layer" pin
  green.]
- The discard restores and never deletes. Because every proof covers a tracked file,
  `_discardTcFiles` loses its `git clean` branch and throws if it is handed an untracked entry.
- Existing tests that pinned the old line were moved to proven fixtures. Each assertion still
  pins the same behaviour: the strict-boolean opt-in, the re-proven clean tree, and naming the
  files. D1 retires `.tangleclaw/` as a discardable fixture.
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
  its backup (D5), in `lib/update-applier.js`, built to the binding rulings above. The carry
  compensates on any late failure (D3d), and the backup is written 0600, atomically and without
  overwriting an earlier one (D5). Each binding condition gets a test: a conflict leaves the
  bytes and flags untouched, and injected restore, checkout and write failures each compensate
  back to the exact starting state. Git is always called in argv form, and every
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

- Carried in from the Chunk 01 review: the agent update prompt in `public/session.js` (~L1249) still
  describes the discard set as whole files TangleClaw owns. Reword it in the same edit that adds the
  new code.

**Done when:** the suite is green, the cumulative Critic is clean, and the #1730 repro has been
run against a scratch clone from the issue's steps.

### Chunk 02 build detail (written 2026-09-23, before code)

#### Git behaviour this design rests on (probed in a scratch repo, git 2.50.1)

- A skip-worktree file that is **unmodified** checks out cleanly: the new content is written and
  the flag stays. A modified one that the tag does **not** change is carried by git itself. So
  the carry is needed only when the carried file differs from HEAD **and** the tag changes it.
- A modified assume-unchanged file is hidden from porcelain, and checkout refuses it with "would
  be overwritten".
- `git checkout <tag>` **silently overwrites a gitignored file** at a path the tag starts to
  track. It refuses only a non-ignored untracked one. See D8.
- `git merge-file -p` exits 0 when the merge is clean and N > 0 for N conflicts. A negative exit
  (signal, >127) is an error, never a conflict.
- `git checkout -- <file>` skips skip-worktree entries, so the carry has to clear flags before
  it restores the file.

#### Flow after this chunk (every mutation comes after every check)

1. The existing read-only guards: no-git, no-update, then the dirty classification. The carried
   file is left out of classification only when its porcelain status is exactly ` M` (changed
   in the worktree, not staged). Staged, deleted or unmerged states stay real work (D3a, D9).
2. wrong-ref, fetch, resolve the latest tag. (Unchanged.)
3. **Preflight (D4).** Read `git diff --name-only -z --no-renames HEAD <tag>` and
   `git ls-files -v -z`. For each changed path: a flag on a non-carried path gives
   `skip-worktree` or `assume-unchanged`; a path that exists on disk but is not in HEAD gives
   `untracked-collision`, ignored or not (D8). For the carried file, when it differs from HEAD
   and the tag changes it, compute the three-way merge in a private temp dir (mkdtemp, 0700,
   always removed). A conflict gives `merge-conflict`, and so does a tag that deletes the file
   while the operator has edited it. All findings are collected and returned together as one
   `reconcile-required`, and nothing has been touched at that point.
4. **Backup (D5)** of the exact original bytes, only when the carry will run. The path is
   `<basePath>/backups/global-rules.<fromSha7>-<tag>.md`, the directory is 0700 and the file
   0600. It is written to a temp name with `wx`, fsynced and published with `link()`, which
   never replaces an existing file. An existing file with identical bytes is reused. Otherwise
   the name gets a `.<sha256-8>` suffix, and after that `-2`, `-3` and so on. Any failure
   refuses before anything changes. Which of the two codes that refusal uses is D10.
5. Discard the proven TangleClaw files, if the operator opted in. This moved here from step 1 so
   that a reconcile refusal never follows a discard.
6. **Carry and checkout, with compensation (D3d).** Record the flags, clear them, restore the
   file from HEAD, run `checkout <tag>`, write the merged bytes (temp file, then rename) and
   restore the flags. If any step fails, compensate: go back to the starting ref (`checkout
   main`, or `checkout --detach <fromSha>` from a tag), write the original bytes back from
   memory, restore the flags, and then verify HEAD, the file's bytes and `ls-files -v`. If
   verification passes, the result is either `reconcile-required` with `checkout-collision`
   (a diagnosed "would be overwritten" or untracked-overwrite message), or the original
   `git-error`. If it does not pass, the result is `recovery-failed` (D7).
7. A plain checkout without a carry maps a diagnosed overwrite the same way (`checkout-collision`,
   paths parsed from git's tab-indented list). Every other git failure stays `500 git-error`.
8. Provisioning report, unchanged. Success adds `carried` (D6).

#### New architectural decisions (sent to the Architect at plan-written)

- **D6: A successful carry adds `carried: [{ path, backup }]` to the success result.** The
  operator is told where the pre-update copy lives, and the beacon and the prompt both relay it.
  *Rejected:* logging only, because the operator could not find the backup.
- **D7: A failed compensation returns a new code, `recovery-failed` (500).** Its body carries
  `recovery: { fromSha, fromRef, backup, failedStep }`, and it is added to every list of codes
  (ADR 0010). *Rejected:* reusing `git-error`, because that code promises "nothing moved; one
  `git checkout <fromSha>` recovers", which is false once the file's bytes or flags are lost.
  `reconcile-required` is excluded too, since D4 allows it only after the starting state is
  restored.
- **D8: `untracked-collision` also covers gitignored paths**, because git overwrites those
  silently (probed). *Cost:* a release that starts tracking a path installs generate as ignored
  state would block each of those installs until the file is moved. *Rejected:* matching git,
  which lets authored ignored content (`.tangleclaw/memories/…`) be lost with no signal.
- **D9: A ` M` carried file appears in neither `dirty.discardable` nor `dirty.realWork`.** It is
  neither of those things, and listing it under real work would tell the operator to commit or
  stash rules they edited in the dashboard. Any other status for it stays real work.
  *Rejected:* a third `dirty.carried` list, which adds to the contract without giving any
  consumer something to do.
- **D10: A failed backup (D5 "refuses") is `reconcile-required`, with a new reason
  `backup-failed`.** It is returned before anything changes, and its action names the backup
  directory. *Rejected:* `git-error`, because the failure is not in git and nothing moved.
  *Rejected:* a separate code, which would mean one more code for a refusal already inside D4's
  envelope.

#### Architect rulings on D6–D10 (2026-09-23, message 4b503584) — binding

- **D6: APPROVED.** `carried: [{path, backup}]` only on an actual carry; the backup is host-local
  recovery evidence, and no wording may imply it was published or copied elsewhere.
- **D7: MODIFIED.** `recovery-failed` (500) is approved, with a mandatory stop and no restart, and
  it reaches every ADR 0010 consumer and list. `recovery` keeps `{fromSha, fromRef, backup,
  failedStep}` and adds `observed: {headSha, ref, fileMatchesOriginal, flagsMatchOriginal}`, each
  null when it cannot be read. `failedStep` is a stable enum (`MOVE_STEPS`), never exception prose.
  The UI and prompt say manual recovery is required and claim nothing beyond `observed`.
- **D8: APPROVED.** An ignored path the target begins tracking is an `untracked-collision`,
  intersected with the target's changed paths. Never moved or deleted automatically.
- **D9: MODIFIED.** Add `dirty.carried` (a path list). An exact ` M` carried file goes there; staged,
  deleted, unmerged or ambiguous states stay `realWork`. When other work blocks, the operator
  still sees that Global Rules was detected and will be kept.
- **D10: APPROVED.** `backup-failed` stays in the reconcile envelope. It names the carried path and
  the backup-directory condition, low-level errors are not shown, unpublished temp files are
  removed, and no repository bytes or flags change.
- **Required, not optional:** the opted-in TangleClaw discard runs only after the whole read-only
  preflight, because D3/D4 forbid any reconcile refusal following a discard mutation.

#### Found while building

- `git update-index --no-skip-worktree --no-assume-unchanged` in one call leaves skip-worktree set
  (git 2.50). `_setFlags` sets one flag per call, and the skip-worktree carry test covers it.
- An untracked file that porcelain shows is refused by the dirty guard (`dirty-tree`, real work)
  before the preflight runs. In practice `untracked-collision` is reached by ignored files, which
  is exactly D8's case. Test (d) asserts both.
- A discarded TangleClaw file is not reinstated by compensation. It is the operator-approved
  restore of TangleClaw's own proven change, and since every refusal now comes before the discard,
  the only failures that can follow it are late ones (checkout-collision, git-error,
  recovery-failed).

#### Done-when: the #1730 repro, run 2026-09-23

The issue's steps, run on a `git clone --shared --no-checkout` of this install: `checkout v5.28.0`,
append the issue's `## Testing (Mandatory)` rule to `data/global-rules.md`, then `update-index
--skip-worktree`. Porcelain came back empty, and a raw `git checkout v5.29.0` aborted with the
issue's exact error. Then `applyUpdate()` ran on the same clone, with its `git`, `gitBytes`,
`repoDir` and `backupDir` seams pointed at the clone and its real `origin`. Result: `ok: true`,
`toRef: v5.29.0`, the flag is still `S`, and the file equals v5.29.0 plus the operator's four lines.
The backup is 0600 and equals v5.28.0 plus those lines, byte for byte. The route and the CLI pass the
applier's result through unchanged; `test/api-update-apply.test.js` pins the route's status and body
for both new codes.

#### My implementation calls (none of the triggers apply)

- The `action` texts use dashboard and editor wording only (ADR 0010 clause 3). For example,
  merge-conflict reads: "Your edits to Global Rules change lines this release also changes. Open
  Global Rules, copy your additions somewhere safe, remove them, update, then add them back."
- The backup directory comes from `store._getBasePath()`, required when the backup step runs
  and through an `_internal` seam, so a failure loading it becomes a refused backup and never a
  broken module.
- The merged bytes and the original bytes are held in memory, so compensation never depends on
  the backup being readable.
- Plan correction: `docs/user-guide.md` and `docs/configuration-reference.md` do **not** list
  the codes (checked by grep). The documents that do are ADR 0010 clause 5, `FEATURES.md`, the
  prompt in `public/session.js` and the gitignored `api-contract.md`. `FEATURES.md` still calls
  `.tangleclaw/*` discardable, which went stale in Chunk 01, and it is fixed here.

## Status

- [x] Chunk 01 — updater discards only proven-TangleClaw deltas (#1537)
- [x] Chunk 02 — global-rules carry-or-block (#1730)
