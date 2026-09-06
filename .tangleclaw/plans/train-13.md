---
artifact: build-plan
version: 2
scope: train-13
depends_on:
  - artifact: wrap-direction
  - artifact: architecture
  - artifact: security-model
  - artifact: test-specs
governed_by:
  - artifact: wrap-direction
    dispositions:
      - "1. Value over an LLM alone — the mechanical spine is the framework's contribution → conforms. Chunks 02 and 03 exist BECAUSE the spine currently emits a wrong provenance stamp (#797) and consumes an unowned payload (#840); both fixes restore the commitment rather than depart from it."
      - "2. Engine-agnostic by construction → conforms. No chunk adds a model-conditional branch. Chunk 01 relocates a hook that is already claude-only by profile capability, and the relocation is declared in the engine profile layer, not hardcoded per model."
      - "3. Gates are advisory by default; hard only where failure is silent or destructive → engaged explicitly in Chunk 02 and Chunk 03. #840's stale-payload refusal and #882's conflict-marker detector are both proposed as HARD, and each is argued against the bright-line test in its chunk rather than assumed. #797's fix adds no gate at all."
      - "4. Model-specific behavior is discovered, never hardcoded → inapplicable because no chunk in this train touches wrap-rule proposal or the self-learning loop."
  - artifact: architecture
    dispositions:
      - "a read that could not be established reports null and names itself, never a plausible default → conforms, and Chunk 02 is the norm applied. #910 is the same principle one step further: a read must not report by ACTING either. `getSessionStatus` keeps reporting that a wrapping session appears finished — it stops being the thing that makes it so."
      - "a dependency's failure degrades TangleClaw, never crashes it → conforms. Chunk 02's stale-payload refusal halts one wrap step with a named reason; it does not crash the server, and Chunk 03's CI detector runs outside the product entirely."
  - artifact: data-model
    dispositions:
      - "a project's configuration travels with the project — <project>/.tangleclaw/project.json is the source of truth, the projects table holds only a queryable summary → conforms, and it constrains Chunk 05's shape: the two-phase apply must order the disk write and the DB summary so a rejected field leaves NEITHER written, rather than treating the table as the thing to keep consistent."
  - artifact: observability-strategy
    dispositions:
      - "logs carry names, never payloads → conforms. Chunk 02's refusal names the run-id mismatch and the path; it does not log the stale summary's contents, which are a managed project's prose."
      - "every logged error says what failed, why, and what the operator can do → conforms; called out explicitly in Chunk 02, whose whole value is that a refusal is visible."
last_validated: 2026-09-06
---

## Requirements Confidence

**Level:** High

**Why:** Every car is a filed bug or backlog item with a diagnosed mechanism, and each
diagnosis was re-verified against the code in this repo before the plan was written rather
than taken from the issue text ([[feedback_issue_diagnosis_is_a_hypothesis]]). Three
verifications that changed the plan's shape:

- **#797** — `lib/wrap-steps/continuity-write.js:213` `_mapDelta` runs
  `git diff --name-status <merge-base>...<tip>`, a branch-wide diff, and then filters through
  `featuresToc._isIndexableCandidate`. That is both halves of the reported symptom at once: the
  cumulative inventory AND why every `.tangleclaw/` path in the actual commit is absent from
  the record. Root cause confirmed, single site.
- **#1022** — `syncEngineHooks` (`lib/engines.js:3164`) writes to
  `path.join(projectPath, '.claude', 'settings.json')` unconditionally and has no
  `isPluginGoverned` guard, as the issue's audit states. Confirmed by reading the function.
- **#1275** — reproduces in this working tree right now: `.claude/settings.json` is dirty at
  plan time, and `test/repo-governance-reference.test.js:147` is the check that would fail if
  the wrap swept it in. This train's own wraps strand until Chunk 01 lands, which is why
  Chunk 01 is first.

The train's theme is a single defect class, which is what makes the roster coherent rather
than a list: **a mechanism writes, finalizes, or records something the caller did not ask
for and cannot see.** Each chunk takes one shape of that.

**Open assumptions / unknowns:**

- [ASSUMPTION: #1132 resolves as option 2 (repair the malformed pair) rather than option 1
  (refuse) | MED impact | user can override at Chunk 06]. The issue explicitly leaves the
  choice to whoever owns the priming roll and names option 2 as "most work, best outcome".
  Chunk 06 designs against option 2 because it is the only one that satisfies both existing
  contracts at once — `test/wrap-step-priming-roll.test.js:219` pins "user prose between
  misordered markers MUST survive", and the unbounded-growth concern needs idempotence.
  Option 1 breaks the first; option 3 keeps a second policy alive.
- [ASSUMPTION: Chunk 01 relocates the hook and retires the old entries, but does NOT attempt
  to make `isPluginGoverned` measure session-side plugin activation | HIGH impact | user can
  correct]. #1022's fourth comment establishes that a committed `settings.json` does not by
  itself restore governance-on-clone, because Claude Code ≥2.1.195 does not auto-load a
  plugin from an external marketplace. That is a real finding and a separate decision (it
  touches #1021 and the marketplace-source trade-off). Chunk 01 restores *the ability to
  commit the file* and says so in its own words; it does not claim to restore
  governance-on-clone. The residue is filed, not silently absorbed.
- [ASSUMPTION: #828's ingress half (`CADDY_LABEL`, ports 8443/8080) is out of scope | MED
  impact | user can override]. The issue itself raises the question and declines to answer
  it. Chunk 04 unifies the base-directory derivation, which is the stated defect, and files
  the ingress-global half rather than widening the chunk into a second-install feature.

**What would raise confidence:** N/A at High. The two MED assumptions are decisions rather
than unknowns, and both are surfaced at the chunk that would act on them.

## Status

- [x] Chunk 01: The machine-local hook moves out of the shareable file (#1022, #1242, #1275)
- [ ] Chunk 02: A read does not finalize, and a payload proves whose run wrote it (#910, #840)
- [ ] Chunk 03: The provenance record says what the session did, and corruption is detected (#797, #882)
- [ ] Chunk 04: One derivation of the base directory, one containment predicate (#828, #1052)
- [ ] Chunk 05: Validate every field before writing any, in the real run and the rehearsal (#1033, #929)
- [ ] Chunk 06: One managed-block policy for a malformed marker pair (#1132)

Context: Plan written 2026-09-06 against the roadmap's blessed Train 13 roster and order
(`ROADMAP_STATE.md`, "Train 13: Nothing Mutates Behind Your Back"). The roadmap leads with
**#1022 (fixes #1275, #1242)**, which is why the hook relocation is Chunk 01 rather than the
status-poll fix carried in session memory.

**Chunk 01 is done** — branch `fix/1022-hook-to-settings-local`, Critic
`rev-20260906T011122Z-b1f1f02b` (29 findings: 19 fixed, 9 accepted, 1 filed onto #1035) then
`rev-20260906T013813Z-edfb34f4` verifying all 13 gating findings fixed with none new. Filed rather
than absorbed: **#1276** (a committed install reference does not mean a loaded plugin, so a clone
reads as governed while its contributor has neither the plugin nor TC's guide) and a comment on
**#868** carrying #1275's surviving third remedy — any red check still strands a wrap PR silently.
#1275's second remedy was descoped with the reasoning recorded in the chunk above.

**One lesson worth carrying into every later chunk.** The relocation's safety rested on
`settings.local.json` being gitignored, and the evidence for it — 16 of 16 managed projects ignore
it — measured the wrong thing: `git check-ignore -v` attributes the rule to the operator's
USER-GLOBAL ignore file, which travels with a home directory rather than a repository. A
per-path check on one machine cannot establish a property of every clone. Chunks 03 and 04 both
have preconditions of this shape (a CI detector's reach; a base directory that must relocate as a
whole), so ask of each: *whose machine makes this true, and does it travel?*

Next: Chunk 02 (#910, #840).

## Scaffolding

No new scaffolding: every chunk edits existing modules in an established repo. Two standing
constraints govern where the work happens.

**This clone is the running install** ([[project_repo_is_the_live_install]]) — the server
serves `public/` straight off the working tree, so an edit there is deployed the instant it
hits disk. No chunk in this train touches `public/`; the roster is `lib/`, `scripts/`,
`.github/workflows/` and `test/`, which the running process holds in its `require` cache
until it is restarted. That bounds the hazard rather than removing it: after a chunk merges,
the live install is behind until it is pulled and restarted, and saying so is part of each
chunk's close.

**Merge strategy is squash**, per `project-preferences.md`, which overrides the plugin's
merge-commit default. Squash-merged branches are therefore single-use — never reuse one, or a
later review gate over-counts already-merged work against a stranded merge-base. Delete each
branch at merge, and mind [[project_changelog_squash_misfile]]: a squash landing after a raced
wrap can misfile the branch's CHANGELOG entry under a fresh release heading, so every
`[Unreleased]`-boundary edit is followed by `grep -E "^## \[" CHANGELOG.md | head -5`
([[feedback_verify_changelog_structure_post_edit]]).

`project-preferences.md` also sets PR create and merge to `wait_for_user`. The operator
opened this train with an explicit instruction to run it autonomously and stated they would
be away, which is the override; it is recorded here rather than assumed, so a later reader
sees a decision and not a lapsed preference.
[DECISION: PRs are created and merged without a per-PR confirmation for this train | the
operator's session-opening instruction was "do it autonomously … I'll be back in an hour",
which is the preference's own escape hatch exercised deliberately rather than a standing
change | user can veto, and the preference file is unchanged]

## Verification Strategy

Tests are the floor, not the evidence. Three of the six chunks change behavior no unit test
observes from the outside, so each names what is exercised for real:

- **Chunk 01** — the proof is a wrap that merges. After the relocation, `.claude/settings.json`
  must be clean in a working tree that has launched a session, and
  `test/repo-governance-reference.test.js` must pass against a tree where `syncEngineHooks`
  has just run. That is the #1275 reproduction inverted.
- **Chunk 02** — drive a real wrap through `memory-update` with a hand-planted
  `.tangleclaw/.wrap-summary.md` from a different run and confirm the step refuses rather than
  parses. Separately, poll `getSessionStatus` against a session whose tmux is dead and confirm
  `git log` in the project is unchanged.
- **Chunk 03** — run a wrap on a branch with more than one commit and diff the emitted
  `files:` line against `git diff --name-only` for that session's own range. The disjoint-set
  proof in #797 is the acceptance test, run in the other direction.
- **Chunks 04, 05, 06** — unit-level, and verified by mutation: each fix's guard is mutated
  and must go red ([[feedback_measure_against_the_real_shape]]). Per
  [[feedback_never_stash_in_swarm_worktrees]], mutation checks use diff/patch, never
  `git stash`, and the harness backs up **every** file it touches and prints `git status`
  after restoring.

Every chunk ships on its own branch and its own PR, merged before the next begins — the
roadmap's Train Execution rule, and the reason each chunk's Critic mode is `chunk` rather
than a single cumulative pass over the whole train.

## Build Chunks

### Chunk 01: The machine-local hook moves out of the shareable file

- **Description:** `syncEngineHooks` writes TangleClaw's `SessionStart` hook, carrying an
  absolute path to one machine's checkout, into `.claude/settings.json` — the file the
  operator's own convention says is shared and committable. Every managed project then has
  to choose between a clone that works and committed governance, and in this repo the
  consequence is sharper: the wrap's `git add -A` sweeps the dirty file into the wrap commit,
  where the repo's own required check rejects the absolute path, and the PR strands with
  auto-merge armed while the wrap reports success. Move the hook to
  `.claude/settings.local.json`, carry the ownership and retirement machinery with it, and
  retire the entries already written to the old location so no project keeps an orphan.
- **Closes:** #1022, #1242, #1275
- **Depends on:** none. First because it is the only car that breaks this train's own
  delivery path: until it lands, every wrap PR this train produces strands the same way
  PR #1273 did.
- **Artifacts consumed:** `security-model.md` (what may live in a committed file),
  `architecture.md` (engine profile layer)
- **Deliverables:** `lib/engines.js` — `syncEngineHooks` writes and reconciles
  `.claude/settings.local.json`; `_mergeBaselineHooks`, `_isTangleClawHookEntry`,
  `TC_HOOK_SCRIPTS` and `TC_LEGACY_HOOK_MARKERS` keep their current home and gain a second
  call site, because ownership is what carries the relocation: the retirement pass runs
  against the OLD file so existing projects are cleaned rather than left with a stale entry.
  That is #1007's lesson applied in advance — a relocation that does not retire orphaned 25
  entries across 24 projects last time, and this one moves the same hooks again. The
  non-claude branch clears TangleClaw's entries from **both** files, since a project that
  flipped engines can hold a phantom in either.

  **Scope decision, recorded rather than silent.** #1275 offers three remedies and calls
  (1) "the real fix … removes the whole class". This chunk builds (1) and files the other
  two, on evidence rather than preference:
  - (2) *exclude TC-written files from the wrap's staging* — after (1),
    `.claude/settings.json` is no longer rewritten, and `.claude/settings.local.json` is
    gitignored by Claude Code convention, so `git add -A` cannot sweep either. The remaining
    instance of the shape is `CLAUDE.md`, a different file with a different ownership
    question, already tracked as #1241. The natural change site is
    `lib/git.js#commit`, which is a general-purpose helper with callers beyond the wrap, and
    `_classifyDirty` lives in `lib/update-applier.js` serving the self-updater's dirty-tree
    path. Narrowing a shared helper for one caller's benefit is its own design decision.
  - (3) *make a stranded wrap PR visible* — genuinely NOT closed by (1): any red check still
    strands a wrap PR while the wrap reports success, because `lib/wrap-steps/pr-merge.js`
    deliberately does not wait for CI. That is a new reporting surface, not a line in this
    chunk, and it is the one piece of #1275 that survives its own root-cause fix.
  [DECISION: Chunk 01 ships #1275's remedy (1) and files (2) and (3) | (1) is the root cause
  and the issue says it removes the whole class; (2)'s remaining instance is a different
  tracked issue and its change site is a shared helper; (3) is a new surface that would push
  this chunk past one Critic pass | user can override and widen the chunk]
- **Tests:** unit — the hook lands in `settings.local.json` and never in `settings.json`;
  a pre-existing TC entry in the old `settings.json` is retired on the next sync while
  operator-authored hooks in that file survive untouched (the #752 contract, which the move
  must not break); `enabledPlugins` / `extraKnownMarketplaces` are preserved verbatim in the
  tracked file, since `lib/governance-state.js` anchors on them. Integration — after a
  simulated launch, `test/repo-governance-reference.test.js` passes against the resulting
  tree, and the wrap's staging set excludes `.claude/settings.json`.
- **Acceptance criteria:** a session launch in this repo leaves `.claude/settings.json`
  unmodified in `git status`; a project that previously received the absolute-path hook has
  it removed from the tracked file on the next sync; a wrap commit in this repo does not
  contain `.claude/settings.json`.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. `/prawduct:critic` run and blocking findings resolved
  3. The residue is filed, not absorbed: an issue for the `isPluginGoverned`-measures-a-file
     divergence established in #1022's fourth comment, since Chunk 01 does not close it
  4. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 02: A read does not finalize, and a payload proves whose run wrote it

- **Description:** Two shapes of the same defect, one chunk because the fix is the same
  discipline in both places. `getSessionStatus` is a read that the session page polls
  continuously; on its dead-tmux branch it calls `autoCompleteWrap`, which writes the wrap
  complete, tears down the Medusa listener, and runs a real `git commit` in the operator's
  repository. Nothing about the request says mutate. Separately, `lib/wrap-steps/ai-content.js`
  parses `.tangleclaw/.wrap-summary.md` from a well-known path with no binding between the
  file and the run that should have produced it — a leftover from the previous session is
  syntactically perfect and becomes this session's commit subject.
- **Closes:** #910, #840
- **Depends on:** Chunk 01 (so the chunk's own wrap PR can merge)
- **Artifacts consumed:** `wrap-direction.md` commitments 1 and 3, `architecture.md`
  (session state machine)
- **Deliverables:** `lib/sessions.js` — `getSessionStatus` reports that a wrapping session
  appears finished and finalizes nothing; finalization moves to a path that is an action:
  the launch path already handles stale wrapping rows (#105), and that is the natural home.
  `lib/wrap-steps/ai-content.js` and the `memory-update` step — the arming step unlinks any
  existing `.wrap-summary.md` before writing, AND the payload carries the run's identity,
  which the consumer verifies. Both, per the issue: the delete handles the ordinary case,
  the stamp catches the case where the delete did not happen.
- **Tests:** unit — a status poll against a dead-tmux wrapping session leaves the wrap row,
  the listener, and the repository untouched, and the #105 guarantee holds (a wrapping row
  never becomes unrecoverable); a `.wrap-summary.md` stamped with another run is refused
  loudly rather than parsed, and an unstamped legacy file is refused rather than trusted.
  Integration — a full wrap still detects its own completion through whatever surface
  replaces the poll's side effect, because the session page depends on that timing.
- **Acceptance criteria:** polling status through a wrap never writes to the operator's git
  history; a planted stale `.wrap-summary.md` produces a hard refusal with a reason naming
  the mismatch, not a skip and not a parse.
- **Critic mode:** final
  <!-- Override: inference picks `chunk` mid-plan. This chunk re-times when a wrap
       finalizes, and the session page depends on that timing — #910 says so and is
       the reason the work was not folded into #908. Coherence across the state
       machine matters before Chunk 03 changes what the wrap records. -->
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. The refusal is argued against `wrap-direction.md` commitment 3's bright-line test in
     the PR body — a payload that cannot be attributed is the "reports success while
     shipping something broken" case, or it is not, and the chunk states which
  3. `/prawduct:critic` run and blocking findings resolved
  4. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 03: The provenance record says what the session did, and corruption is detected

- **Description:** The wrap's `files:` field records a cumulative branch inventory, not the
  session's changed set — verified disjoint from the actual commit across 12 sessions on
  `RentalClaw-Project`. `_mapDelta` in `lib/wrap-steps/continuity-write.js` diffs
  `<merge-base>...<tip>`, which is the whole branch, and then filters the result through
  `featuresToc._isIndexableCandidate`, which is why every `.tangleclaw/` path the wrap
  actually committed is missing from its own record. It is bookkeeping, but authoritative-
  looking bookkeeping: it already mis-tiered a `/prawduct:critic` run in a consuming project
  by putting `skills/` paths into a changed-file set the session never touched. Paired with
  it: raw conflict markers sat on `main` in a tracked governance file across three sessions
  and nothing noticed — a detector that is one `git grep` and runs in under a second.
- **Closes:** #797, #882
- **Depends on:** Chunk 02 (which settles what the wrap's payload is allowed to be trusted for)
- **Artifacts consumed:** `wrap-direction.md` commitments 1 and 3
- **Deliverables:** `lib/wrap-steps/continuity-write.js` — the session's own changed set,
  sourced from the session's range rather than the branch's, and the decision about
  `_isIndexableCandidate` made explicitly: a provenance stamp that silently drops the paths
  the commit contains is the defect, so the filter belongs on the Map, not on `files:`.
  Second deliverable: a conflict-marker step in `.github/workflows/test.yml` running
  `git grep -nE '^(<{7}|={7}|>{7})( |$)'` over the tree, failing the run on a hit.
- **Tests:** unit — `files:` for a session on a branch with prior commits contains exactly
  that session's paths and none of its predecessors', asserted as a set equality rather than
  a subset (the disjoint-set proof run in reverse), and `.tangleclaw/` paths present in the
  commit are present in the record. The CI detector gets a fixture with each of the three
  marker forms and one with none, so a green is not vacuous
  ([[feedback_finding_fix_is_new_code]]).
- **Acceptance criteria:** a wrap on a multi-commit branch emits a `files:` line equal to
  `git diff --name-only` over that session's range; a tracked file carrying a conflict marker
  fails CI.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. The `## Instances` entry #797's reporter drafted is registered in
     `.prawduct/artifacts/wrap-direction.md` — it is this repo's governing artifact and the
     reporter deliberately declined to edit it from a consuming project
  3. `/prawduct:critic` run and blocking findings resolved
  4. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 04: One derivation of the base directory, one containment predicate

- **Description:** Two instances of one rule implemented twice and disagreeing. The
  TangleClaw base directory is computed from `process.env.HOME` in `lib/store.js` and from
  `os.homedir()` in `lib/master.js`, `lib/git-template.js`, `lib/server-info.js` and roughly
  eight more sites; on macOS `os.homedir()` reads the passwd entry and ignores `$HOME`. They
  agree today, so nothing looks wrong — until someone sets `HOME` to attempt an isolated
  install, and gets a half-sandbox where the database relocates while master state, git
  templates and the plist keep writing to the operator's live `~/.tangleclaw`. That is worse
  than no sandbox, because it looks isolated. Alongside it: `resolveWithinProject` in
  `lib/project-paths.js` resolves symlinks and excludes the project root, while
  `lib/wrap-steps/priming-roll.js:474` hand-rolls a purely lexical check that counts the root
  as inside. That difference is intentional today and is not a bug — it is the drift shape a
  prior chunk spent two Critic rounds eliminating in the version-bump classifier.
- **Closes:** #828, #1052
- **Depends on:** Chunk 03
- **Artifacts consumed:** `architecture.md`, `security-model.md` (containment is a boundary
  predicate)
- **Deliverables:** one base-directory derivation in `lib/store.js`, consumed by every site
  that currently calls `os.homedir()` for this purpose, with a documented override so a test
  install on the same machine is possible without inventing one
  ([[feedback_verify_env_override_before_sandboxed_launch]] records that inventing one is
  exactly what happened before). `lib/project-paths.js` grows an explicit root policy —
  `allowRoot` — and `lib/wrap-steps/priming-roll.js` migrates its three call sites onto it;
  the scope caveat in `project-paths.js`'s module docstring narrows to match what is then
  true.
- **Tests:** unit — with `HOME` overridden, every derivation site resolves to the same base;
  the containment helper's root case is asserted both ways (`allowRoot` on and off) and
  priming-roll's directory validation keeps its current semantics. Per
  [[feedback_verify_mechanism_uniformity]] and [[feedback_enumerate_the_guards_family]], the
  chunk enumerates the full call-site family by grep before changing any of them, and the
  tests that still PASS after the default changes are treated as the suspects.
- **Acceptance criteria:** no site derives the base directory independently; `HOME` set to a
  scratch path relocates all of it or none of it, never half.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. The ingress half is filed rather than silently descoped: `CADDY_LABEL` is a constant and
     the ingress ports default to 8443/8080, so a base-path override alone does not make a
     second install on one machine safe — #828 raises this and declines to answer it
  3. `/prawduct:critic` run and blocking findings resolved
  4. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 05: Validate every field before writing any, in the real run and the rehearsal

- **Description:** `updateProject` mixes validation, DB writes, disk writes and methodology
  switching across roughly a dozen PATCH fields in one 397-line function, and its own
  comments document a past partial-update bug that the shape keeps inviting: a later field's
  rejection leaves the earlier fields' writes standing. Refactor to a per-field validator
  table with a two-phase validate-all → apply-all, so no field is written before all are
  validated. The same defect one level up in `scripts/reset-admin.js`: with
  `--password-stdin --dry-run`, the rehearsal does not read or validate the piped password at
  all — it prints a plan claiming it "would prompt", exits 0, and blesses a password the real
  run refuses. Found during a live auth verification, and a dry-run that diverges from the
  real run is at its most expensive during a lockout, which is the only time anyone runs it.
- **Closes:** #1033, #929
- **Depends on:** Chunk 04
- **Artifacts consumed:** `data-model.md` (project entity and its field constraints),
  `security-model.md` (admin password policy)
- **Deliverables:** `lib/projects.js` — a per-field validator table and a two-phase apply in
  `updateProject`. `scripts/reset-admin.js` — when `--password-stdin` is present the dry-run
  reads stdin and runs `caddy.validateAdminPassword` on exactly the path the real run does,
  refusing the same passwords with the same exit code, and its plan text names the stdin
  source instead of claiming it would prompt.
- **Tests:** unit — a PATCH whose last field is invalid leaves every earlier field unwritten,
  asserted against the DB and the disk rather than the return value; the reproduction from
  #929 verbatim, both invocations, asserting the exit codes match. Per
  [[feedback_measure_against_the_real_shape]] the validator-table fixture is built from what
  the real PATCH callers send, not from a hand-enumerated field list, since the roster is
  extensible and a fixture enumerating today's keys stays green on a dead reader.
- **Acceptance criteria:** no partial application survives a rejected PATCH; `echo short123 |
  node scripts/reset-admin.js --password-stdin --dry-run` exits 1, matching the real run.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. `/prawduct:critic` run and blocking findings resolved
  3. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 06: One managed-block policy for a malformed marker pair

- **Description:** TangleClaw splices a managed block into a file it co-owns with another
  writer in two places, and they disagree on what a malformed marker pair means.
  `lib/engines.js#_mergeManagedBlock` refuses, leaves the file byte-identical and surfaces an
  error; `lib/wrap-steps/priming-roll.js#_replaceManagedBlock` appends a fresh block. They
  cannot corrupt each other — the marker names differ — so this is a consistency question
  with one real consequence: priming-roll's append is not idempotent on a malformed file, so
  the next wrap sees the same misordered pair and appends again, one block per wrap forever,
  every appended block stale the moment the next lands. Refusing has the opposite failure —
  the roll silently stops updating until a human looks. Repair the pair instead: rewrite it
  into a single well-formed block, preserving everything between the misordered markers as
  user content outside it. That satisfies the existing contract
  (`test/wrap-step-priming-roll.test.js:219` pins that user prose MUST survive) and is
  idempotent, which neither of the other options is.
- **Closes:** #1132
- **Depends on:** Chunk 05
- **Artifacts consumed:** `architecture.md` (`configFormat.mergeStrategy: 'managed-block'`)
- **Deliverables:** one shared managed-block helper with an explicit malformed-marker policy,
  homed where the general mechanism already lives (`lib/engines.js`,
  `configFormat.mergeStrategy: 'managed-block'`), with `lib/wrap-steps/priming-roll.js`
  migrated onto it so the two share a policy by construction rather than by review.
- **Tests:** unit — a file with `END` before `BEGIN` is repaired to one well-formed block on
  the first pass and is byte-identical on the second (the idempotence the append lacks), with
  the prose between the misordered markers present in both; the existing priming-roll
  contract test is satisfied by the new behavior rather than weakened to accommodate it —
  tests are contracts, and if it must change, the change is argued, not made.
- **Acceptance criteria:** repeated wraps against a malformed priming file produce a file of
  constant size; no path both refuses and appends.
- **Type:** cumulative-final
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. Committed, then `/prawduct:critic cumulative` run and blocking findings resolved
  3. Train 13's quick win picked on adjacency to what shipped, per the standing ritual, and
     checked for a deploy/TCC touch before being called quick
  4. PR merged, chunk marked `[x]` in Status
