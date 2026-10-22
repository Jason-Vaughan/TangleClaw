# Change Log — TangleClaw

<!-- Append new entries at the top.

Merge conflicts: a conflict at the top of this file is expected, because every branch
prepends here. Keep both entries, newest first. In a lane, rebuild the file as origin/main's
copy plus your own entry. `.gitattributes` deliberately does not union this file (#2042):
union kept both sides' lines without a conflict and silently corrupted entries.


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

## 2026-10-22 — #2248 T04: the launch domain out of lib/store.js, in two modules

<!-- prawduct: type=chore | scope=2248-area-extraction -->

#2248 T04. v5.35.0 Wave 3 chunk W3-A1, plan r2 (sha256 `abe8af62` at dispatch, S01, T01, T02 and T03 ticked; the step-0 seam recorded under the chunk after dispatch, both copies `e1afbc7d`); Part of #2248, which stays open for Part 2. Built on `feat/2248-t04-store-launch` from `origin/main` `832860a2` under dispatch token `W3-T04-2248-832860A2-ABE8AF62`.

**What moved, unchanged.** The `// ── Launch sequences (Train 21) ──` section left `lib/store.js` as two files, because the step-0 matrix showed its two halves share nothing. `lib/store/launch.js` holds the first half (`LAUNCH_STEP_IDS`, `_insertLaunchSequence`, `_claimInheritedNotice`, `projectRecoveryStateApi`, `recoveryClearancesApi`, `_insertRecoveryClearBatchItem`, `recoveryClearBatchesApi`, `_clearRecoveryCas`, `OPERATOR_RECOVERY_CLEARANCES`, `launchSequencesApi`, and the six `_rowTo*` mappers they read through). `lib/store/handoffs.js` holds the second (`_rowToHandoffPublication`, `_rowToHandoffEpoch`, `handoffEpochApi`, `handoffsApi`) together with the `EPOCH_ROW_MISSING` constant from the facade's header, whose only reader is the epoch api. Three regions cut by line range and emitted byte for byte; the facade imports back the eight names it still exports and re-exports them under the names it always exported. The `HANDOFF_*`, `EPOCH_UNKNOWN_FROM_V41` and `RECOVERY_BATCH_OUTCOMES` constants the plan listed already lived in `lib/store/_schema.js` since T01 and did not move again.

**The seam (INT `83a1e7c7`, Architect A410).** Each module keeps its own `let _db` and guards over it with its own `_ensureDb`. The handoffs module needs nothing but the handle and the schema's baseline vocabulary, which it requires from `./_schema` directly (the schema requires no domain module), so it is handle-only in `BOUND_MODULES`. The launch module filters two readers on `SESSION_STATUS.ACTIVE`, a constant the sessions domain owns, while `lib/store/sessions.js` requires the launch module for the insert its `start()` runs: requiring sessions back would be a cycle, so the constant arrives beside the handle, `launch._bind({ db, SESSION_STATUS })` from `init()` and `_bind(null)` from `close()`, the way the schema already receives the same constant. `lib/store/sessions.js` is the one re-pointed reader: it now requires `./launch` and `./handoffs` directly, drops the two injected `let`s, and its `_bind(db)` shrinks to the handle as it joins `BOUND_MODULES`, still clearing the launch-blocker warning memory when unbound. Dependency graph: `_db ← _schema ← handoffs`; `_db ← launch`; `sessions → launch, handoffs`; the facade requires all of them; nothing under `lib/store/` requires the facade.

**Records and tests.** `docs/areas.json`: the `launch` area gains both files; `shared.holds` keeps `launch` because its routes are still in `server.js`. Two lifecycle pins (PM `ab65826c`): `test/handoff-store.test.js` and `test/launch-sequence.test.js` each close the store, assert the moved apis refuse with `NOT_INITIALIZED`, re-open it and assert they answer again. No `docs/*`, `FEATURES.md` or `CONTRIBUTING.md` line names a moved symbol, so none is repointed and `FEATURES.md` is untouched. `changelog.d/2248.t04-store-launch.internal.md` carries the `### Internal` entry.

## 2026-10-22 — #2248 T03: the session-rules domain out of lib/store.js

<!-- prawduct: type=chore | scope=2248-area-extraction -->

#2248 T03. v5.35.0 Wave 3 chunk W3-A1, plan r2 (sha256 `d6b4dfa2` at dispatch, S01, T01 and T02 ticked); Part of #2248, which stays open for Part 2. Built on `feat/2248-t03-store-session-rules` from `origin/main` `179ae6c8` under dispatch token `W3-T03-2248-179AE6C8-D6B4DFA2`.

**What moved, unchanged.** `lib/store/session-rules.js` holds the `// ── Session Rules ──` block (`_snapshotSessionRule` through `_proposeTextChange`, `sessionRulesApi`, the `SESSION_RULE_STATUSES`, `SESSION_RULE_TRANSITIONS`, `SESSION_RULE_KINDS` and `SESSION_RULE_CRITIC_GATES` lists, and the version retention with its setter), the rule-delivery ledger that sat inside the launch region (`SESSION_RULE_DELIVERY_CHANNELS`, `SESSION_RULE_DELIVERY_OUTCOMES`, `RECEIPT_MAX_AGE_MS`, `RULES_SERVED_BY_LAUNCH_SEQUENCE`, the delivery retention and its setter, `_rowToSessionRuleDelivery`, `_pruneSessionRuleDeliveries`, `sessionRuleDeliveriesApi`), the conflict-candidate token helper `_significantTokens`, and from the `Row Mappers` section `_rowToSessionRule` and `_rowToSessionRuleVersion`: four blocks cut by line range and emitted byte for byte. The facade imports back the eleven names it still exports and re-exports them under the names it always exported; its `rule-label` require lost its last reader and is removed.

**The seam (Architect A409).** The module keeps its own `let _db` and guards over it with its own `_ensureDb`. The step-0 scan found one facade-resident call the domain still makes, `projectsApi.get` inside `create`, so the module is bound by name beside the schema and the sessions domain, `_bind({ db, projectsApi })` from `init()` and `_bind(null)` from `close()`, and never requires the facade; when the projects domain has a module of its own, this one imports the api from it and the binding shrinks to the handle. The token helper is not in the plan's T03 list: its only two readers are inside `findConflictCandidates`, it reads no handle, and nothing exports it, so it moves with the section rather than being injected. Beyond those, the module requires only the logger, the handle module (`StoreError`, `_withSavepoint`), the activity log and `rule-label`, none of which reaches the facade.

**Text readers and tests.** `test/self-improvement-loop.test.js` greps the store for `setStatus`'s UPDATE shape and now reads the new module, a path change only. Every `readdirSync` walker under `test/` was read against the moved code before the first commit: none of their counted tokens occur in it, so no census moves and no scanner exemption is added. New in `test/session-rules.test.js` (PM `ab65826c`): the rules and delivery apis refuse with `NOT_INITIALIZED` after `close()` and answer again after the next `init()`. The binders pin from the keystone covers the new module by construction.

**Map and docs.** `docs/areas.json`'s `session-rules` area gains `lib/store/session-rules.js`; `shared.holds` keeps `session-rules` because its routes are still in `server.js`. The one `docs/session-rules-self-improvement.md` line that located `SESSION_RULE_TRANSITIONS` in the facade now names the module (PM `ab65826c`, mechanical path repoint).

## 2026-10-22 — #2248 T02: the sessions domain out of lib/store.js

<!-- prawduct: type=chore | scope=2248-area-extraction -->

#2248 T02. v5.35.0 Wave 3 chunk W3-A1, plan r2 (sha256 `6a354364` at dispatch, S01 and T01 ticked); Part of #2248, which stays open for Part 2. Built on `feat/2248-t02-store-sessions` from `origin/main` `938ca75b` under dispatch token `W3-T02-2248-938CA75B-6A354364`.

**What moved, unchanged.** `lib/store/sessions.js` holds the `// ── Sessions ──` block (`SESSION_STATUS`, `SESSION_STATUSES`, `SESSION_STATUS_TRANSITIONS`, `canTransition`, `_statusSourcesFor`, `_transitionSession`, `sessionsApi`, `_getSessionById`) and, from the `Row Mappers` section, the four session row readers (`_rowToSession`, `_warnUnreadableLaunchBlocker`, `_launchBlockerFromRow`, `_launchBaselineFromRow`) with the warning cap and memory they read (`LAUNCH_BLOCKER_WARN_CAP`, `_launchBlockerWarned`), two blocks cut by line range and emitted byte for byte. The facade imports back the seven names it still reads or exports and re-exports them under the names it always exported.

**The seam.** The module keeps its own `let _db` and guards over it with its own `_ensureDb`. The step-0 scan found two facade-resident helpers the domain still calls, both of which leave with the launch domain: `_insertLaunchSequence` (inside `start()`'s transaction) and `handoffsApi.bindLifecycleEligibility` (inside `wrap()`). They reach the module the way the schema receives what it calls, `_bind({ db, handoffsApi, _insertLaunchSequence })` from `init()`, bound by name beside the schema rather than through `BOUND_MODULES`, so the module never requires the facade. The launch-blocker warning memory moved with its warner: `close()` used to clear the set directly and now unbinds the module, whose `_bind(null)` clears it, so a database opened later in the same process still warns for its own rows. Two phrases from the keystone that said a forgotten bind "fails at first use" now say the first call that guards, since the activity log's `log()` is lenient by contract; the plan's chunk id leaves the three `test/store.test.js` lines that carried it.

**Tests.** No test that greps `lib/store.js` lost its needle (`engineId: row.engine_id` has five other homes in the facade), but one test that walks all of `lib/` did: `test/startup-dialog.test.js` counts `setLaunchBlocker(` callers and skipped the store by its one filename, so the method's definition in `lib/store/sessions.js` read as a new writer and PR CI run 39716567120 went red on `b00ae7ee`, the head the PR opened on; the skip now names exactly `lib/store/sessions.js` beside `lib/store.js` (PM `f4c67f03`, bounded; the other store modules stay scanned so a call from one of them is still caught), a path change only. New in `test/store-sessions.test.js`: the sessions domain refuses with `NOT_INITIALIZED` after `close()` and answers again after `init()`; and the warning memory does not outlive the database it described (warn once, read again silently, close, open a fresh database that hands out the same session id, warn again). The binders pin from the keystone covers the new module by construction.

**Map.** `docs/areas.json`'s `sessions` area gains `lib/store/sessions.js`; `shared.holds` keeps `sessions` because the session routes are still in `server.js`.

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
