# Change Log — TangleClaw

<!-- Append new entries at the top.

Tag-line conventions (ART-4K9M, ratified 2026-07-17):
- scope=  : ONE scope per unit of work. Work done under an ACTIVE build plan uses that
  plan's frontmatter scope (its ## Status roster derives checkbox flips from these tags).
  Post-plan work — backlog items, GH-issue fixes, chores landing after the plan is
  archived — gets its OWN scope (kebab-case of the backlog id or issue, e.g. ui-2p7t,
  wrap-583), NEVER a borrowed scope from an archived plan: an archived roster can't track
  new chunk ids, so borrowed tags rot (the ART-4K9M failure). A scope with no build-plan
  file is fine — regen-views flags it only while status=merged, and deliberately not once
  status=shipped (retired/planless scopes are expected history).
- chunks= and status= : **RETIRED upstream (prawduct 3.4.0, `lib/change_log.py`), along with
  the derived views that were their only reader.** Which chunks an entry shipped now belongs in
  the entry BODY, where readers actually look — the 2026-09-06 entries write `Train 13 Chunk NN.`
  as their first line. Historical entries carrying either key still parse (the parser preserves
  unknown keys), so nothing below needs rewriting; the two bullets that follow are kept as the
  record of why they existed and are no longer instructions. Noted 2026-09-06 because this header
  still read as live guidance and produced a `chunks=05` tag line on the Chunk 05 entry before a
  Critic pass caught it.
- status= : (none) on branch → `shipped` stamped at merge (AMENDED 2026-07-17, ratified
  under ART-7W2J/PRW-9K4C: upstream trunk semantics — TC restarts the server onto main
  right after merge, so merged work IS live; the wrap's version number is bookkeeping.
  The prior intermediate `merged` state created a merge→wrap window where prawduct
  3.0.5's fail-closed regen-views flagged every planless small-fix scope fatally).
  The WRP-9F2K release flip stays as a safety net (flips any `merged` stragglers at
  the next wrap promote); a STATUSLESS tag line remains the missed-stamp diagnostic.
  TC skips `release=` tokens — CHANGELOG.md is TC's release-notes surface, not
  prawduct's release-notes.md. regen-views derives build-plan Status checkboxes from
  status=shipped ONLY — the old convention left released work stuck at `merged`, which
  un-ticked genuinely shipped chunks (2026-07-17 back-stamp: 29 entries across
  v4.5.0–v4.19.0).
-->

<!-- Older entries live in .prawduct/change-log-archive/YYYY-MM.md, moved there verbatim by `prawduct-hook archive-change-log`. -->

## 2026-09-23 — A new file is admitted by a decision, and a cleared draft is kept privately rather than logged (#1724, #1507)

<!-- prawduct: type=feature | scope=train-a-car-a3 -->

Train A Car A3 Chunk 03. A wrap committed any file changed after launch, and a file a session creates is always changed after launch, which is how scratch scripts and query dumps reached `main` (#1721). Separately, the prompt clear before every injection logged the pane's last line, the engine's status footer, as the operator's draft, and a real draft was destroyed unrecorded.

**Admission is a positive decision.** `_file-ownership.classify` gives a path HEAD has never held (`newToRepo`: `??` or index `A`), first seen after launch and not written by a wrap step, the foreign reason `untracked-new`. It waits for Include/Leave through the existing decision UI. The files TangleClaw writes into a project (project config, engine config carriers) are exempt (`_tc-owned-paths.judge` → `tangleclawWritten`), and #1619's identity refusal still applies. The commit and PR bodies list the session's files and the operator's inclusions from one staged entry. A wrap step's own write is matched by resolved path, which fixes a symlinked project path making the wrap ask about its own output.

**Drafts are read by the engine's profile and kept out of the log.** Every injection passes the session's engine and attempt. `medusa-wake.readComposerDraft`, the single reader beside `locateComposer` and `_composerEmpty`, returns the draft. `lib/draft-store.js` keeps it per attempt (`0700`/`0600`, no symlink follow, last 20, deleted 7 days after the attempt ends), and the log carries only an opaque `draftRef` with row and character counts. Where the composer cannot be located, the prompt is still cleared, so a paste cannot submit operator text joined to the injected text, and the log says the draft was not captured.

Architect rulings F1–F5 (message 5b0eaa0d) and G1 MODIFY / G2 APPROVE (message cdce349b). The Operator set retention to 7 days (relayed by the PM, message c30f56b6). ADR 0002 has a dated section. Fixed in passing: `update-applier-authored-content`'s file seam depended on how deep the checkout sat, and it failed on macOS on a clean `main`. `tag_issues.sh` and `tag_issues_2.sh` are removed.

## 2026-09-23 — Wrap gates are engine-aware: a non-Claude wrap of a Prawduct project is an honest checkpoint (#1738)

<!-- prawduct: type=feature | scope=train-a-car-a3 -->

Train A Car A3 Chunk 02. A wrap from a Codex/Aider/Antigravity session of an onboarded project ran `prawduct-hook stop` anyway. The probe wrote Prawduct's evidence store, `version-bump` stamped `.prawduct/change-log.md`, and a preflight that measured nothing counted as evidence produced, so the handoff could read `complete`.

**One capability per run.** `governance.methodologyCapability` answers available / not-applicable / capability-unavailable. It is keyed on the session's engine (`governance.sessionEngineId`), and "onboarded" means `.prawduct/` or the plugin reference, whatever the engine. The runner resolves it once and hands it to every step as `context.methodology`. Two new first-class statuses, `not-applicable` and `capability-unavailable`, join `STEP_STATUSES`, and every consumer knows them (the vocabulary test enforces this).

**Dormant means untouched and unauthorized.** Preflight never spawns the hook. `version-bump` holds the cut. `commit` withholds auto-merge and leaves `.prawduct/` paths out through the classifier's `withheldPrefixes` (shared with `session-files`). `pr-merge` enqueues nothing. The result and `run-start` carry `methodologyAuthority`, and the drawer says "will not merge or release" from the first frame. A failed or stranded wrap PR keeps its own banner.

**Honest evidence.** `capability-unavailable`, and any skipped preflight on a capable engine (including one disabled by an override, per Architect E3), degrade the handoff. The handoff document gains an optional `methodology` block. The next capable launch renders an advisory `/prawduct:doctor` directive (never onboard, never "authority restored").

Architect rulings E1–E6 (message 9a774624). The Operator approved the rule #5 amendment (engine-neutral wrap mechanics vs provider-owned methodology effects), relayed by the PM in message 8af0c8ec. ADR 0002 has a dated section. Fixed in passing: handoff-stage read `project.engine`, which does not exist. Follow-up: #1809 (capability-matched admission and attested rotation). Tests: `test/governance-methodology-capability.test.js`, `test/wrap-methodology-authority.test.js`, and the preflight, version-bump, pr-merge, commit, file-ownership, session-scope, handoff-publish, launch-preflight-context and launch-steps suites. The preflight fixture now names its engine, because an unknown engine fails closed.

## 2026-09-23 — A wrap's keep-running intent is explicit, and a live wrap can be cancelled before it commits (#1708, #1707)

<!-- prawduct: type=feature | scope=train-a-car-a3 -->

Train A Car A3 Chunk 01. Before this change, only the wrap modal could keep a session running, so every other caller's wrap ended the session (#1708). The drawer's control also read as a way to stop a live wrap, but no stop existed (#1707).

**Keep-running intent.** The new project setting `wrapKeepSessionRunning` is resolved once, before the claim (`sessions._resolveWrapIntent`). The order is an explicit request boolean, then the project setting, then `false`. An unreadable config or a non-boolean setting refuses with 409 `WRAP_KEEP_SETTING_INVALID`. A Retry inherits the trusted run record. One value therefore feeds the registry, handoff-stage and the kill decision. `projectConfig.plannedSessionOutcome` is the single derivation for the 202, `run-start` and `/wrap/status`.

**Cancel.** The new route is `POST /wrap/cancel {runId}`. `wrapRunRegistry.admitStep` makes each step boundary one atomic decision: an accepted cancel stops the run before the next step, the `commit` step included, and admitting `commit` closes cancellation for good. A cancel accepted during a step that then halts still ends the run as `cancelled`. The outcome is `outcome: 'cancelled'`, which offers no Retry or Skip. A `cancel-requested` stream event makes the cancel visible to every watcher. The drawer shows Hide and Cancel wrap, the conditional planned-outcome line, and "Past the point of cancellation" with the real step.

ADR 0002 is amended per Architect rulings D1–D5, with a supersession pointer to this entry. The unreachable stalled/lost re-follow was removed at Critic review. Its real defect is filed as #1805, and #1806 covers #1708's stranded Medusa inbox. Tests: `test/wrap-intent-cancel.test.js`. Seven existing tests pinned "keep sent only when true" and the exact option and status key sets; they were updated to the new contract with equal-strength assertions.

## 2026-09-23 — Operator Global Rules edits survive an update, or it refuses before anything moves (#1730)

<!-- prawduct: type=bugfix | scope=train-a-car-a2 -->

Train A Car A2 Chunk 02. The problem: an install that had customised `data/global-rules.md` could not take a release that changed that file. Without `skip-worktree` the dirty guard refused with no way forward. With it, `git checkout <tag>` aborted with a raw error. `applyUpdate` now runs a read-only preflight after fetch (`_preflight`). It three-way merges the carried file (HEAD / working copy / tag), finds flagged, untracked and ignored paths in the tag's way, and returns one `409 reconcile-required`. Before anything moves, it writes the exact original bytes to a private backup that is never overwritten (`_secureBackup`). Only after that does the operator-approved discard run. The move (`_moveToTag`) clears flags, restores, checks out with `--no-overwrite-ignore`, writes the merged file and restores the flags. On any failure it compensates, then re-observes the result. `recovery-failed` (500) is returned, carrying `observed` facts, only when that re-observation fails. Built to the Architect's D1–D10 rulings (messages a358b1ba, 4b503584), which are recorded in the plan. Found while building: git ignores `--no-skip-worktree` when it is combined with `--no-assume-unchanged` in one call, so `_setFlags` sets one flag per call. Tests: `test/update-applier-global-rules-carry.test.js`, a real-repository suite covering (a)–(f), compensation, the backup rules and the dirty-guard interaction. Beacon and route tests cover the two new codes. The issue's 5.28.0→5.29.0 skip-worktree repro, run on a scratch clone, updates with the edit kept.

## 2026-09-22 — The self-updater discards only changes proven to be TangleClaw's (#1537)

<!-- prawduct: type=bugfix | scope=train-a-car-a2 -->

Train A Car A2 Chunk 01. `_classifyDirty` counted every `.tangleclaw/` path as TangleClaw-written, so an update deleted an uncommitted plan while the dialog said nothing of the operator's was listed. Discard ownership is now a per-delta proof held in one `PROOFS` table: `CLAUDE.md` changed only inside its managed region, and `.claude/settings.json` changed only by TangleClaw retiring its own hooks (`judgeHookSettings`). Everything else is real work, including all of `.tangleclaw/`. `_discardTcFiles` restores from HEAD and no longer deletes files. Architect rulings D1/D2 accepted (message a358b1ba). Tests: a real-git regression suite (`test/update-applier-authored-content.test.js`), 3 of whose 4 cases fail against the old code, plus a pin of the settings path to `engines.SHARED_HOOK_SETTINGS_PATHS`. The fixtures that pinned `.tangleclaw/` as discardable moved to proven fixtures, keeping the same assertions.

## 2026-09-22 — The committed CLAUDE.md block names the freshness verb

<!-- prawduct: type=chore | scope=claude-md-freshness-verb -->

The generated TangleClaw operational block in root `CLAUDE.md` is rebuilt at every launch from `lib/tc-verbs.js#VERB_ROSTER` (via `lib/ecosystem-primer.js`). #1794 added `freshness` to the roster but not to the committed copy, so the live checkout read one uncommitted file after the restart onto it. The line is byte-identical to what the server regenerated.

## 2026-09-22 — One fleet view of every live checkout (#1678, #993)

<!-- prawduct: type=feature | scope=train-a-car-a1 -->

Train A Car A1 Chunk 03. `GET /api/checkouts` and `tc freshness` (`lib/checkout-fleet.js#fleetView`) give one row per project with a live session, from the same `checkout-freshness#projectCheckout` the project route, prime and chip read, shaped per caller as the Architect ruled (D11, D16 MODIFY, D17–D20): operator and Master every row, a bound project itself and its groups' members, an unbound caller `scope: 'none'` with the reason, and a presented-but-not-honoured binding `403 PROJECT_BINDING_INVALID` (tc exits 2). Rows are an allowlist with no path; names the caller cannot see are withheld and the summary re-rendered. `checkouts` joins both `tc capabilities` rosters, so the prime's verb list names `freshness` (prime-golden fixtures regenerated; only that line moved). R-12: `system-health#detectStaleServer` reads the banner's `impactSnapshot`, so records-only is clear and anything unclassified still fires. Carried O-1/O-3/O-4 from the Chunk 2 review. Cumulative Critic rev-20260922T225136Z-f3bb9f69: 0 blocking; R-1/R-2/R-3/R-4/R-8 fixed and verified (rev-20260922T225614Z-d430f3e3), the rest accepted on the record. Closes #993 and #1678.

## 2026-09-22 — Every related session shows the same upstream target (#1678)

<!-- prawduct: type=feature | scope=train-a-car-a1 -->

Train A Car A1 Chunk 02. `lib/upstream-observer.js` observes `origin/main` once per repository identity (`ls-remote origin refs/heads/main`, 5-minute cache, single-flight, network-bound, never a fetch; off with behind-origin's switch, per D10). `checkout-state` gains `repository.identity`: the normalized origin URL, where a local remote becomes an opaque `file:<sha256(realpath)>` per D14 as modified. It also gains `compareSnapshot` against the observed SHA: `behind-unknown` when the clone lacks the commit, found by `rev-parse --verify --quiet`, because `cat-file -e` exits 128 on `^{commit}`, as the real-git test proved. `lib/checkout-freshness.js` composes the `checkout` block: `localRef`, `upstream`, `vsUpstream`, `owner`, the install-only `runtime`, and `summary`. `summary` comes from `lib/checkout-summary.js`, and the prime and the session chip both show it. `GET /api/projects/:name` carries the block on the whole row only. The session chip re-reads that row on the status poll's cadence (D12), and the launch route warms the checkout alongside the CI probe, bounded at 5s (D13). `lib/git-probe.js` is the shared async runner (R-11, D15); git failure reasons are scrubbed of paths and URLs. Architect rulings D12–D15: D14 modified, the rest approved. Critic: rev-20260922T211920Z (0 blocking; 6 warnings, 7 notes: R-9 fixed, R-10 accepted and filed as #1790, R-11/R-13 accepted, the rest fixed), verify rev-20260922T213404Z (0 findings; O-1..O-6 accepted, with O-1/O-3/O-4 carried to Chunk 3). The full suite is green by a TAP run.

## 2026-09-22 — The dashboard says what the live checkout is on and whether a restart matters (#993, #1678)

<!-- prawduct: type=feature | scope=train-a-car-a1 -->

Train A Car A1 Chunk 01. `lib/checkout-state.js` measures one checkout (lock-free `status --porcelain=v2 --branch -z`, `rev-parse origin/main`, `rev-list --left-right --count`) and fails closed: every unread fact is null, named in `incomplete`, and never zero. It is cached for 30s per directory with single-flight, and reads `pending` before the first measurement. `classifyRange` classifies `startupSha..currentDiskSha` for restart impact (records-only allowlist, both sides of a rename, `unknown` on any failure or on equal SHAs). `/api/server-info` gains `liveCheckout` and `restartImpact`. `behindOrigin` gains `state` and `reason`, and only symbolic-ref exit 1 counts as detached. The dashboard's live-checkout banner (no action, no dismiss) and the stale banner's impact wording: a records-only range hides that banner's restart button, per Architect ruling D6. Architect rulings D1–D11: D6 and D11 modified, the rest approved; D11 lands in Chunk 3. Critic: chunk rev-20260922T194448Z (1 blocking, a false absence of the gitignored api-contract; 2 warnings; 12 notes: fixed, with R-11/R-12/R-14/R-15 accepted and R-11/R-12 carried in the handoff), verify rev-20260922T195754Z (0 findings; O-1/O-2 accepted). The full suite is green by a TAP run.

## 2026-09-22 — The wrap bumps a Python project's version in pyproject.toml (#1444)

<!-- prawduct: type=bugfix | scope=train-b2-chunk4 -->

Train B.2 Chunk 4. `lib/project-version-files.js#parsePyprojectVersion` is a line scanner for the static PEP 621 `[project] version`, returning offsets into the raw text so `version-bump.js#_resolvePyproject` swaps only the value; every uneditable shape (dynamic, inline table, multi-line or unquoted value, duplicates) is a named skip. `_multilineStateAfter` tracks `"""`/`'''` the way TOML does, ignoring them inside single-line strings and comments. `_resolveVersionSource` probes version.json → package.json → pyproject.toml, passing over only a valid version-less package.json (`isVersionlessPackageJson`, shared with the reader; both parse through `parsePackageJsonText`, which drops a BOM). Both detection ladders go through `readProbedVersion`, which reaches pyproject.toml only where the writer would; #58's read past an unusable version.json to package.json is kept. A configured `versionFilePath` named pyproject.toml gets the TOML reader; another non-JSON file now says what is supported. The issue's claim that the setting could overwrite TOML with JSON was false (JSON.parse refused it first). Architect rulings: A1–A5 approve, A6 modify (no auto follow-up), A5 refinement modify (version.json never passed over), #58 conflict approve with a scoped legacy exception. Critic: chunk rev-20260922T180344Z (0 blocking, 3 warnings, 2 notes, all fixed), verify rev-20260922T182340Z (1 observation, fixed), verify rev-20260922T182959Z (0 findings; 3 observations accepted). Checked on a scratch copy of TangleBrain's real pyproject.toml + CHANGELOG.md: 0.25.0 → 0.25.1, one line changed. Plan archived at `.tangleclaw/plans/archive/b2-chunk4-pyproject-version.md`.

## 2026-08-20 — #990: forensic review of the ungoverned Antigravity window fixes 8 confirmed bugs

<!-- prawduct: type=bugfix | scope=antigravity-window-990 | chunks=01,02,03,04,05,06,07 -->

A 5-dimension multi-agent adversarially-verified review of commit range `v5.8.0..v5.10.0` — a
window where a different AI engine (Antigravity) committed directly to `main` with no Prawduct
governance active — surfaced 17 raw findings collapsing to ~10 distinct root issues. One
(`startWrapSse` ReferenceError) was already fixed post-v5.10.0 by #1005. This work fixes the rest,
confirmed still live on `main`:

- Shared-doc `fs.watch` handles never re-targeted on a `filePath` edit and leaked on delete — the
  most severe finding, independently corroborated by 4 of 5 review dimensions.
- `codex.json` advertised `capabilities.supportsSilentPrime: true`, but `syncEngineHooks()` clears
  hooks for any non-`claude` engine instead of writing them — not dead code, a live UI lie: an
  operator could enable "Silent Prime" for a Codex project and nothing would happen. Turned off;
  real support filed as backlog ENG-8V3N.
- Multi-file upload had no `FileReader.onerror` — a failed read hung the modal forever.
- CHANGELOG's `## [5.9.0]` "Master Session Recovery" `### Fixed` entry was fabricated (no such fix
  exists anywhere in history) — corrected via an `[Unreleased]` note, without touching the locked
  released section.
- Removed the dead live-wrap-progress SSE subsystem (zero consumers since #1005 removed its only
  client) and deduped shared-doc notify logic between two drifting implementations.

Cumulative Critic review (`rev-20260820T181429Z-411d7e43`): 0 blocking, 2 warning + 2 note, all
fixed and re-verified clean. Full suite: 6508 pass / 0 fail / 1 skipped.

One thing worth naming for the next reader of this repo's history: two of the fixes above exist
*because* re-checking a claim rather than trusting it surfaced something worse than reported — the
Codex "dead code" finding turned out to be a live capability lie, and a shipped commit's own
message ("Added Next Action preview") didn't match what the diff actually built (documented
honestly in `FEATURES.md` rather than propagated).

<!-- prawduct: type=bugfix | scope=master-level-takes-effect-968 | chunks=01,02 -->

The first real use of #755 found it: the toggle moved, the guard permitted the write, and the Master
refused anyway. It was refusing itself — the change path refreshed the guard and not the identity, so
the Master read `read-only` from month-old instructions and never attempted the write the guard was
waiting to allow.

Three things generalise:

- **"One call site is not the family" applies to ARTIFACTS, not just code sites.** #755 chunk 1 made
  the guard immediate and chunk 2 put the level into the identity; the change path refreshed one of
  the two, and every test in the suite read one of the artifacts that WAS being written. The fix was
  to delete the partial refresher rather than add a third write to it.
- **A detector that fires on the healthy path is worse than no detector.** The first shape of the
  staleness check compared the identity's mtime to the session start — and the identity was rewritten
  unconditionally on every ensure, which both surfaces fire on drawer open. It would have shown
  "restart to apply" permanently, which is the exact permanent nag the ruling behind it rejected.
  Caught by review, not by me. Write-if-changed; the mtime is load-bearing, so not touching it is
  part of the contract.
- **Verify a mechanism before offering it as an option.** The tmux session-start comparison was
  probed before it was put to the operator as a choice, and the probe found more than the bug: the
  live Master had been running a month against instructions rewritten the day before, so *nothing*
  regenerated in that month had reached it.

Also learned: `tmux display-message` does not fail on an absent session — it answers for the attached
client — so an exact-match target cannot protect it and the caller must check existence separately.
The codebase already documented this at one call site; the new one repeated the mistake. It cannot be
held behaviourally in a headless run (no attached client to fall back to), so a source-level guard
holds it, and the guard had to strip comments first because both callers explain the hazard in prose
directly above the check.

**Chunk 2 — Master Kill (also #768 chunk 3).** `POST /api/master/kill` plus the bar's Kill button,
which shipped dim from #768 waiting for this route. It is the remedy chunk 1 makes load-bearing: the
guard binds a level change at once, the running Master does not, so restarting it is what makes it
act. Killing an absent Master is SUCCESS — the operator's intent is "not running" and it already
holds — while a tmux that will not answer refuses, because a kill that could not be confirmed is not
a kill, and `hasSession` would have flattened that wedge into "already stopped" during exactly the
condition where the Master is most likely still running. `kill` leaving `tcMasterPendingReasons` is
the assertion that the pending treatment came off WITH the backend rather than beside it — the same
pattern `access` set in #755.

**Classification:** bugfix
