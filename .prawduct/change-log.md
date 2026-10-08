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

## 2026-10-07 — #2188: a project stores its selected model (persistence)

<!-- prawduct: type=feature | scope=2188-engine-model-selection -->

Chunk 03 of the #2188 build plan, dispatched by the PM. Storage, validation and reporting only: no launch reads the field, no selector is on, no schema change.

**What landed.** `model` in the project config, beside `engine`. One row in `lib/projects.js#PROJECT_UPDATE_VALIDATORS` judges a saved model with `engine-models.checkSelection` against the engine the project will have after the request; an unreadable roster refuses the save. An engine change clears the model unless the request supplies one for the new engine, and the save's `warnings` say so (`modelAfterUpdate`, `modelClearedWarning`). A stored model that stops being selectable is kept and reported: the project payload carries `model` and `modelCheck` (`storedModelReport`). Every engine payload carries `modelSelection`, with `declared` telling a profile with no `models` key from one set to null (Architect A141), and `GET /api/engines` carries the offered models with their availability.

**Three departures from the design, each sent to the PM with the local head.**

- *A save that stores a model says no launch uses it yet* (`MODEL_NOT_YET_LAUNCHED`). The design did not have this. Each chunk merges and deploys alone, and until the launch chunk a stored model changes nothing; ADR 0013 does not let a setting be accepted in silence when it has no effect. The launch chunk removes the sentence, its test, and the filter that keeps `model` out of the "applies to the next launch" warning meanwhile.
- *The profile-binding refusal is in the store.* The design refuses "binding a profile to a project with a model". Nothing in the product binds a profile except `store.projects.update`, so that is where `MODEL_SELECTED` is thrown; the PATCH table has no such field.
- *The offered-models list is not on a project's own engine payload.* Building it parses the CLI's roster (356 KB for Codex on the build host), and that payload is built for every project on a polled list. The project payload carries the profile-only state, and a list of projects reads the roster once per distinct engine and model.

**Moved out, by agreement with the PM at dispatch.** The `sessions` columns: `requested_model` goes with the launch chunk, the evidence columns with the evidence chunk.

**Not duplicated.** The design promised a regression test for #2189 here (a Codex project on Bypass switched to Antigravity reads back `default`). `test/launch-mode-settings.test.js` already pins it on `main`.

**Review.** The first review found no blocker and two things worth fixing, both fixed in the second commit: the validator read the engine from `project.json` before the project row, so a checkout whose file had drifted could store a model the same response reported as unselectable; and a save under a running session said the model "applies to the next launch" beside the sentence saying no launch uses it. The remaining notes are accepted on the record. Four older validator rows still read the engine from `project.json` first; they predate this work and were reported to the PM as a candidate issue.

**Not covered.** No live launch, since no launch reads the field. The wider roster, the launch argument, the requested-versus-actual check and the selectors are later chunks.

## 2026-10-07 — #2189: an engine change no longer carries the launch mode onto the new engine

<!-- prawduct: type=bugfix | scope=2189-engine-change-mode-reset -->

Dispatched by the PM as the prerequisite for #2188 (Architect ruling A122, item 5: the engine-change mode reset is required).

**What landed.** `lib/projects.js#launchModeAfterUpdate` decides the default launch mode a project holds after an update: a mode named in the update, else `default` on an engine change, else the stored mode reconciled as before. The hidden-picker guard and the engine-change write both read it. The save's `warnings` name the reset. The dashboard settings modal shows `default` when its engine dropdown moves to another engine and always sends the mode with an engine change (`tcLaunchModeForEngine`, `tcLaunchModePatch` in `public/api-helper.js`).

**A contract was reversed, deliberately.** Two tests from #731 pinned the old behaviour: "preserves bypass when switching to an engine that DOES honor it" and "demands re-confirmation when the new engine DOES honor the warned mode", which then kept Bypass. Both are rewritten to the new rule, not weakened: the first now asserts the reset in four switch directions among the engines sharing the key, the second that no confirmation is asked when the switch itself resets the mode, with a new sibling asserting that Bypass named for the new engine behind a hidden picker is still refused until confirmed. The reason is in the tests' comments: #731 itself noted the carried posture differs in blast radius, and that difference is the defect.

**Why the server fix alone was not enough.** The modal carried the selected mode across the dropdown change when the new engine had the same key, then omitted it from the save because it equalled the stored value. With only the server reset, the modal would have shown Bypass while the server stored Interactive, and an operator who re-chose Bypass for the new engine would have had the choice dropped.

**Added after the cumulative review.** A launch with `engineOverride` applied the stored default to the override engine whenever it honored the key, the same carry-over by another route (API callers only; no UI sends the field). `launchSession` now applies the stored default only to the project's own engine. The review also showed that no test told "reset every mode" from "reset only a warned one", since `bypassPermissions` is the only non-default key Claude, Codex, Antigravity and Aider share; a Claude to OpenClaw case on the warning-free `plan` now does, and the modal test derives its engine list from `data/engines/`.

**Added after the Architect's exact-head review (A143).** The reset was reported only when the request left the mode out. The dashboard never does that: its mode control resets when the engine dropdown moves and the save sends the default by name, so a dashboard operator got no word after the save. The warning now follows the outcome (the project went in on a non-default mode and came out on the default across an engine change), and a mode the request chose for the new engine is not called a reset. The same review's CI run failed two tests in `test/wrap-intent-cancel.test.js`, whose harness runs the real `doSaveSettings` and did not supply the new `tcLaunchModePatch`; it now passes the real helper. I had not run that file: every file that evaluates `doSaveSettings` is now in the local run.

**Not covered.** The Project Master's own `master.launchMode` follows the older keep-if-honored rule when its engine changes; that is a separate setting with its own store and was outside this issue. Filed as #2197. No live launch was run; the launch command is asserted from the stored mode through `_buildLaunchCommand`.

## 2026-10-07 — #2049: one clear-one-launch function, the fleet read, and no clear for an ended session

<!-- prawduct: type=feature | scope=2049-bulk-recovery-clear -->

#2049 chunk 1 of the plan the Architect ruled on as A93, on the ProjectManager's lease (Medusa `ca422e7b`). Three parts, each its own commit, with the review's fixes in a commit after them. The batch write, its audit and migration, and the fleet panel are later chunks and are held.

**The extraction.** `lib/launch-recovery-clear.js#clearOneLaunch` holds the single clear's checks, the compare-and-set and the `launch.recovery-cleared` activity row. The route keeps the operator proof, status codes, messages and log lines. `test/launch-recovery-clear.test.js` is unedited and passes, which is the evidence that nothing a caller sees changed.

**The ended-session refusal.** The single clear now answers `409 SESSION_ENDED` for a launch whose session is not active. It applies only where the clear would otherwise have been written: an already-cleared launch, a moved revision and an advisory launch keep their answers, so the stale response is unchanged.

**The fleet read.** `GET /api/launch/recovery-held`, served only while the login gate is `armed` and the request carries an operator's session; no CSRF proof, since it changes nothing. The Architect reviewed the field and source mapping before it was built (A96, yes with changes). What changed from the mapping as sent: the startup-fire part states the retention guarantee that actually holds (rows of an active session are exempt), an empty stranded-wrap read is marked `incomplete-history`, a throwing source sends a stable reason code and logs the error, the nudge is labelled a send attempt, and the session status is labelled as stored.

**A requirement that arrived mid-build.** "Uncertain queued work" had no definition when the lease was written. The Architect defined it as reported evidence from identifiable durable sources, with unknown or unavailable where there is none (Architect commit `83192f9`). No source records pane input, so that part always says `unavailable`.

**Review.** Two cumulative Critic reviews, on `29c7e9581` and then on the tree with main merged in: 0 blocking in both. From the first: the fleet read's no-login refusal was aligned with the reconciliation read's (`403 LOGIN_GATE_REQUIRED`) and the API reference row completed; the Launch readiness panel still offering Clear recovery for an ended session's launch is filed as #2178, a panel change outside this chunk. From the second, carried to the batch-write chunk: the rule for which launches an operator may clear is stated in the fleet list's SQL and in `clearOneLaunch`, and the two differ on archived projects.

**Architect hold A133, fixed.** The fleet read had built its own four-field copy of the preflight record, dropping `requiresRecovery`, `requiresReconciliation` and `worktreeDirty` and turning an unparseable record into a null verdict with two false flags. A96 had asked for the stored evidence unchanged. It now sends the stored record as it is, and null when the store cannot parse it; tests pin the three fields, that `worktreeDirty` null stays null, and that an unknown field passes through.

**Not verified.** No live request was made against the running install: this checkout's primary is the running server, and the route has no page yet.
## 2026-10-07 — #2188: the rules for which model an engine may be launched with

<!-- prawduct: type=feature | scope=2188-engine-model-selection -->

#2188 chunk 02 (the design's numbering; chunk 01 was the two spikes). Design approved by the Architect (A124, A131); the design document is kept outside this repository, with the builder's local plans.

**What landed.** `lib/engine-models.js`: `checkSelection`, `offeredWithAvailability`, `roster`, `modelArgv`, `validateModelsBlock`. A model is selectable when it is on the profile's allowlist and in the roster the installed CLI reports now. The Codex profile declares `gpt-5.6-sol` and `gpt-6-luna` with the `codex-models-cache` reader, and `validateProfile` checks any `models` block.

**Added under Architect ruling A135.** The roster carries a freshness bound the original design did not have: `roster.maxAgeHours: 168` for Codex, provisional. A list older than that, one with no readable fetch time, and one dated more than five minutes into the future are all `ROSTER_UNAVAILABLE`. A `models` block that is present but invalid is logged and refused as `MODELS_BLOCK_INVALID`; it is never read as an engine with no model selection. `selectionState` gives every caller the three answers (none, invalid with the errors, ok), and `offeredWithAvailability` returns that state with its list, after the review showed that a boolean and an empty list made a broken block look like an absent one to everything but `checkSelection`. The entry also covers `docs/engine-guide.md` ("Model selection"), `FEATURES.md` and the `CHANGELOG.md` line under Internal.

**No behaviour change.** Nothing calls the module at save or launch yet. `test/engine-models.test.js` asserts the Codex launch command is byte-identical with and without the block.

**From the spikes (design section 9a).** `codex --remote unix://<socket> --model <id>` sets the thread's model on codex-cli 0.156.1, a turn completed on each offered id on this account, and the thread id names the rollout file. That is the evidence recorded in the profile. Antigravity stopped at its folder-trust prompt and was not answered, so it declares no block; the Architect deferred that turn (A131).

**Found, not fixed.** The bundled OpenClaw profile fails `validateProfile` on `main` (no `detection`, no `configFormat` fields). It is a connection-backed template and nothing appears to validate it, so this is recorded here and left alone; the new test compares each profile with itself minus `models` so it does not vouch for it.

## 2026-10-07 — #2059: version-qualified Codex pane fixtures and pinned refusals

<!-- prawduct: type=debt | scope=2059-codex-wake-fixtures -->

#2059, first of three chunks under Architect ruling A104 (PM lease C1). Test-only: no file under `lib/` or `data/` changed.

**What landed.** `test/fixtures/codex-panes/codex-<version>.json` for codex-cli 0.156.1, 0.159.0 and 0.161.0: whole panes read off a private tmux server (throwaway `CODEX_HOME`, fake key, neutral project path), trailing whitespace dropped and nothing else. One pane ran in a second folder: the 0.161.0 folder-trust prompt, because 0.161.0 showed no prompt in the non-git folder the rest used; the fixture says so in its `note`. `test/_wake-fixtures.js` loads them into `CODEX_FIXTURE_SETS` beside the hand-excerpted 0.155.1 set. `test/medusa-wake-codex-fixtures.test.js` adds them to the per-version matrix and adds two blocks: what refuses a pane when no channel has spoken, and which captured versions the profile's `verifiedVersions` gives a channel to.

**Why whole panes.** The 0.155.1 set is three-row excerpts. The state #2059 turned on is one an excerpt would not have kept: the screen Codex opens with draws the empty composer before the folder-trust or update prompt replaces it. It was captured on all three versions, 0.156.1 included (about three seconds there, from one timed run).

**The cell recorded as known unsafe (not a safety pass; Architect A108/A109).** `KNOWN_UNSAFE_IF_CHANNEL_IDLE` names the opening screen: with a fresh idle from the channel the pane gate types into it, because the at-rest marker is the only thing that refuses that screen and a fresh idle excuses exactly that marker. Whether the channel can answer idle while that screen is up is a question for a live channel probe, not a fixture, and it applies to the verified 0.156.1 as much as to the unverified versions. Reported to the PM and Architect; closing it belongs to the later chunks.

**Not covered.** A real model turn (the busy panes are a fake key's first second before its 401), approval prompts, the 0.159+ agent views, and anything about the app-server protocol.
## 2026-09-27 — Sessions reply to Medusa messages in a way that works, and can list what they owe (#1976, Chunk 01)

<!-- prawduct: type=bugfix | scope=medusa-owed-replies -->

The PM dispatched this over Medusa. The Architect admitted Chunk 01 as a low-risk fix: prose fixes, one read-only verb and tests, with no schema, protocol, escalation or UI change. It was aimed at v5.30 and missed it; it ships after v5.31. Chunks 02–03 follow separately. Plan: `.prawduct/artifacts/build-plan-1976-medusa-owed-replies.md` (local, not tracked).

**Problem.** The wake nudge said "mark them handled: raw POST /read, then reply: raw POST /send". It never mentioned `inReplyTo` or the launch headers. A raw `inReplyTo` send without headers is refused (`EXCHANGE_BINDING_REQUIRED`), which B5 hit first-hand today. A reply without `inReplyTo` records no reply, so the initiator stayed blocked. A recipient also had no view of what it owed: `tc message sent` is the sender's view.

**The change.**
- **Text:** the nudge, the prime's Medusa "How to interact" line and the engine config block now name `tc message send --in-reply-to <message-id> <workspace-id> "<reply>"` and put the reply before the ack. The prime edit is net-neutral in length, because a longer Role line pushed the full silent prime over budget and dropped the ecosystem primer. The golden fixtures were caught and regenerated to show only that one-line change.
- **`tc message owed`:** reads the existing `direction=received&open=1` route. It lists replies owed first, with the exact command, then unhandled messages. An `untracked` exchange (state never moves past `untracked`, found live) is counted, never listed.

**Evidence.**
- New tests were red before the change. The untracked filter is mutation-checked.
- The targeted ring is green: 1336 tests. The full suite was not run, under the Pilot Envelope.
- The live `tc message owed` against the running server reported "owe nothing, 1 untracked not counted".

**Filed separately (Architect Q3):** #1987 (the dashboard panel acks on display) and #1988 (the Master cannot reply with `inReplyTo`).

**Review.** Cumulative review `rev-20260927T235204Z-81ec7b19` found 1 blocking finding: the plan's "never use `/clear` as an acknowledgement" line had been dropped silently. It now ships in the nudge and in every config form through a shared `MEDUSA_REPLY_GUIDANCE`, and is descoped from the prime (D1: prime length budget). The review's warnings were also fixed: `owed` reads 200 rows and says when the page is full, skips sends still in flight (no Hub id), and all four config renderings are pinned.

**2026-10-07: main merged in, and the Master's nudge given its own wording.** The branch had fallen behind two releases, so `origin/main` was merged in (a true merge; the `CHANGELOG.md` entries moved under the current `[Unreleased]`, the golden primes were regenerated). A cumulative review at the merged head, `rev-20261007T182304Z-54ead0f0`, found 1 blocking finding in the original change: the nudge template is shared with the Project Master, and the rewrite put `tc message` commands in it. `tc message` resolves a project name, which the Master lacks, so each of those commands refuses in its pane and the only route left in the line was the raw ack. Fix: the API base now picks the form (`lib/medusa-wake.js#_nudgeText`). The Master's line names `POST …/send` then `POST …/read`, reply first, with no `tc message` command; the stranded-nudge matcher derives one pattern from each form and accepts a form only with its own kind of base. Tests: `test/medusa-wake.test.js`, `test/medusa-wake-stranded-nudge.test.js`. The full suite ran on the merged tree; one failure, `test/setup-scan-own-install.test.js`, is the load-sensitive #1999 and is outside this change.

**2026-10-07: the project nudge shortened to fit the composer (Architect ruling A100).** A later review round asked whether the longer project nudge still shows verbatim when pasted. Measured in a throwaway Claude Code 2.1.283 pane on a private tmux socket, read back through `readComposerDraft`: 800 characters paste verbatim, 801 become `[Pasted text #N]`, at 80 and 160 columns. The project nudge named its API base three times and so grew by three times the encoded project name; it collapsed at a 25-character name, and a collapsed nudge fails `isOwnNudge`, so a lost Enter would stop that session's wakes until escalation. The project form now gives the `tc` verbs and names the base once, with `GET /messages, POST /send (inReplyTo + launch headers), POST /read` relative to it (`lib/medusa-wake.js#_nudgeText`, `COMPOSER_VERBATIM_MAX`). The Architect set the bound at 750 for the whole nudge (rulings A102 and A106) and asked that the raw reply route stay named. The maximum measured for names passing `validateName` (a 64-space name, an `https` origin with a five-digit port, a five-digit unread count, the wake reference) is 746 characters; a letter, 62 spaces and a letter under the deployed `https` origin is 739. Both were pasted with Enter withheld and recognised in the same pane, at 80 and 160 columns. `test/medusa-wake.test.js` pins those cases, a plain 64-character name and the Master's form at 750 or less. Names registered by the two routes that skip `validateName` are outside that bound (#2180, filed separately on the Architect's ruling A111). Four existing assertions pinned the three raw routes in the project nudge; they now assert the `tc` commands and the single base, and the paths-disagree test moved to the Master's form, the only one that still repeats its base.

## 2026-10-07 — #1971: session rules gain a lifecycle — retirement, supersession, and approval for edits

<!-- prawduct: type=feature | scope=rule-lifecycle-report -->

#1971 (#1696, #1709), 4 chunks, PM-dispatched design pass → Architect-reviewed (ruling A81) → fresh build on `fix/1971-rule-lifecycle-report`, re-ported from the stale `fix/1696-1709-rule-retirement` branch's design rather than rebased: that branch predates the #2019 caller-authentication gate and claimed a schema version main has since used for five unrelated migrations.

**Chunk 01 — schema v56 + store-layer lifecycle.** `session_rules.status` gains `retired` alongside `proposed | active | rejected`, moving only along `SESSION_RULE_TRANSITIONS` (6 of 16 `(from, to)` pairs allowed; every other pair is `400 INVALID_TRANSITION`, closing the `active → proposed → rejected` two-step the earlier deny-list missed). New columns `replaces_rule_id`, `superseded_by`, `retired_at`, `replacement_origin` carry replacement/supersession provenance. A content change to an active, non-master rule now files a replacement proposal instead of rewriting in place; approving a replacement atomically retires the rule it replaces.

**Chunk 02 — route layer.** `sessionRuleCaller` extended, never replaced. `PUT /api/session-rules/:id/status` drives retire/restore; retirement's password check runs BEFORE the rule is looked up (an Architect-reviewed asymmetry from approval's existing order), so a wrong/absent password answers identically whether the target exists. `PUT /api/session-rules/:id` and `POST .../restore` answer `202`/`replacementProposed` on an active-rule edit. A local Critic review (independent of the Architect's design review) caught one more blocking issue: `REPLACEMENT_PENDING` was thrown by the store but unmapped by either route, falling through to a bare 500 — fixed, with 5 new tests.

**Chunk 03 — UI.** Rules Graveyard (closed-by-default disclosure), Retire (confirm-gated, password-revealed-on-403 like Approve) and Restore (always comes back switched off) in the Project Rules modal; a proposed row names what approving it will do to the rule it replaces, in all four cases (still active / edit of still-active / already replaced by someone else / target gone). Verified by 30 automated tests and a live click-through in a real browser against an isolated scratch server.

**Chunk 04 — docs, `tc rules`, CHANGELOG, mutation-coverage audit, full regression sweep.** `docs/session-rules-self-improvement.md` gets a "Rule lifecycle" section with the transition table held to the live `SESSION_RULE_TRANSITIONS` constant by a parity test. `tc rules` marks a retired rule and says how to propose an amendment. CHANGELOG.md's compatibility-change entry for the 202-on-active-edit behavior. Mutation-coverage acceptance criterion (more than 30 checks across the transition table, caller gate, password gate, and replacement/supersession logic, each confirmed to turn at least one test red): 26 real mutations scripted against the committed source (unique-string substitution, target test run, result recorded, source reverted via `git checkout --`) — 21 already caught, 5 genuine gaps closed with new tests (one pre-existing and unrelated to this branch: the operator-approval password check had no HTTP-level test). Combined with the 16 individually-parametrized transition pairs and the existing 11-route unbound-caller sweep, the total is in the 40s.

**Found while building, not fixed here.** `lib/store.js#_startupControlAtomic`'s name is still scoped to the subsystem it was first built for; this branch adds 3 more unrelated call sites on top of 2 pre-existing ones. Filed as #2164 rather than bundled into this PR (cross-cutting rename, unrelated to the feature).

**Architect ruling A88 (blocking, found on the PR itself).** `POST /api/session-rules` with an operator caller and `replacesRuleId` landed the replacement `active` by default (this route never requests another status) and retired its target in the same transaction (`lib/store.js`'s `sessionRulesApi.create`) — bypassing the delete-password gate this PR adds for retirement via `PUT .../status`, and that approval already requires, entirely. The store-level test proving the mechanism (`session-rule-lifecycle.test.js` "a replacement created already active retires its target at once") never set a real password because store-level tests never go through HTTP; the HTTP authorization tests covered plain `POST` and passworded retire separately, never the combination. Fixed (shape b, the Architect's own framing): the same `checkDeletePassword` check now runs in the route, gated on `caller.operator && replacesRuleId` present, before the store is ever called — mirroring the retire route's existing password-before-lookup principle for the same underlying effect reached a different way. 3 new HTTP tests with a real password configured (wrong, absent, correct), mutation-verified.

**#1709's point 5 is NOT done by this PR, and the PR does not close #1709.** The issue's own acceptance list includes migrating four specific, already-live rows (Builder1 rules 6, 7, 33; Builder2 rule 41) to `retired`. This PR ships the mechanism those rows need, but does not touch them: a schema migration cannot safely guess which pre-existing disabled rows are genuinely dead versus a rule an operator deliberately, reversibly switched off — exactly the distinction #1709 exists to preserve, so auto-retiring on migration would violate the issue's own stated principle. Those four rows are owed one manual Retire action each, through the mechanism this PR ships, once it is live — an Operator/Builder1/Builder2-session action, not a migration. PR body changed from `Closes #1709` to a plain reference so merge does not auto-close it prematurely.

**Review.** Cumulative Critic on `4997ad28b` (rev-20261007T164153Z-96809607): 0 blocking, 1 warning (above, filed), 2 note (backlog reconciliation — #1047/#2016 are pre-existing, untouched, out of scope; #1709's disposition is recorded above rather than closed). Synced to `origin/main` after (merge commit `d80cd8eed`, no conflicts; schema v56 and `sessionRuleCaller` both unmoved on main since the design's merge-base) — full suite re-run green on the merged tree before the PR review. A second cumulative pass at the PR boundary (`rev-20261007T171054Z-8b9a5cbf`, commit `d425bd595`) caught one real BLOCKING gap: `restore()`'s `'restore'`-origin replacement-proposal path was untested, and 3 pre-existing restore tests had silently gone no-op from the same active-rule-edit-defers-to-proposal behavior change this PR introduces. Fixed in `705396f0e` (4 test files: 3 corrected fixtures, 2 new direct-coverage tests, mutation-verified) and closed by `/prawduct:critic verify-resolutions` (`rev-20261007T173715Z-15781152`): 0 findings, composed coverage spans the whole branch with 0 unresolved blocking. The Architect then put the PR itself on a blocking architecture review (ruling A88, above) — fixed per this entry's own addenda.
## 2026-09-27 — Claude panes get a private socket root, so native messaging never needs a shared /tmp (#1904)

<!-- prawduct: type=bugfix | scope=claude-socket-root -->

The PM dispatched this over Medusa. Plan: `.prawduct/artifacts/build-plan-1904-claude-socket-root.md` (local, not tracked).

**Problem.** Claude Code 2.1.283 binds its cross-session socket at `(XDG_RUNTIME_DIR || CLAUDE_CODE_TMPDIR || "/tmp")/cc-socks/<pid>.sock` (read from the binary) and refuses a directory another local user could tamper with. A `/private/tmp` at `0777` therefore switched native messaging off in every pane TangleClaw launched.

**The change.**
- **Module.** `lib/engine-temp-root.js` provisions `<store base>/run/<engine>-tmp` at `0700` and vets it with Claude's own rule: no symlinked TangleClaw-owned component, no ancestor that is group- or world-writable without the sticky bit or owned by another user, and a socket path within 103 bytes.
- **Fails closed.** A root that fails is omitted, and the log names the path, a command to run by hand, and whether Claude's default root works. The launch is not refused (assumption A1, stated on the PR). Nothing TangleClaw does not own is ever chmodded.
- **Profile-driven.** The Claude profile declares `capabilities.privateTempRoot`, which is registered in `READ_CAPABILITIES`.
- **Wiring.** Project panes and the Project Master's pane get the variable above the ambient env floor and below `launch.env`, so an operator-set `CLAUDE_CODE_TMPDIR` wins. `POST /api/sessions/:project` returns `privateTempRoot`.
- **Docs.** `docs/engine-guide.md` separates native messaging from Medusa and gives the manual cleanup for the root, which the OS never clears.

**Evidence.**
- `test/engine-temp-root.test.js`: 24 cases on the real filesystem and through seams.
- Seam tests (sessions, master, a `launchSession` pane hop, the route's 201 field): each is mutation-checked red.
- The targeted ring is green: 29 files, 1306 tests. The full suite was not run, under the Pilot Envelope.
- Live: a throwaway Claude 2.1.283 pane logged `[uds-messaging] Listening: <root>/cc-socks/<pid>.sock`.
- Critic: cumulative review `rev-20260927T225544Z-09327fc5` (1 blocking, the plan's format), resolved by `rev-20260927T230515Z-18770e58` with 0 blocking.

## 2026-10-07 — #2154: a Leave keeps a file out of the wrap commit whatever a later step concludes

<!-- prawduct: type=bugfix | scope=2154-keep-local-leave -->

#2154, single chunk, on the PM's dispatch (Medusa `bcb9fc02`, go `af9a58b7`). The defect behind Architect hold A27: closed PR #1927 carried a file the operator had answered Keep local for.

**Root cause.** `_file-ownership.js#classify` applied an Include / Leave answer only to a path it counted as foreign in that same call, and `session-files`, the changelog gate and `commit` each read ownership from the live tree. With no launch snapshot a path is foreign by change time, so a file answered Leave and then rewritten by something other than a wrap step read as the session's own at `commit` and was staged. The snapshot commit's body lists the file under "Session files", which is rendered from `owned`. Which of the two routes the incident took is not established: the log had rotated and no step records a run's answers.

**The change.** A path that would be `owned` and carries a Leave goes to `left`, and to a new bucket `leftSessionFiles`. The changelog gate excludes that bucket, and the secret check keeps scanning it so its report still names a flagged file the operator left. Architect ruling `44f1a715`: Leave always binds (Q1 a), TangleClaw maintenance is not held back (Q2), a wrap step's later write to a left path stays local (Q3), and answers must not outlive one wrap.

**A contract replaced, not weakened.** `test/wrap-file-ownership.test.js` asserted since #1406 that a Leave cannot drop the session's own file. It now asserts the inverse, under the ruling, with the reason beside it and in ADR 0002.

**Found while building.** The secret check had honored a Leave for the session's own flagged file since #1513, so two guards answered the same question differently. Taking the Leave in `classify` first dropped that file from the scan and from the report; one existing test caught it.

**Answers per wrap.** The page's first request of a wrap carries no path answers and resets what it holds; the server keeps a run's options only for a Retry of that run. Pinned by an executed test of `confirmWrap`.

**Review.** Cumulative Critic on `4378e25d6`: 0 blocking. The API reference row and the ADR's rejected alternative were fixed in a docs-only commit. No wrap was driven on a live install; that check is owed and the PR says so.

**rev-20261007T154444Z-116f5137** — 2026-10-07T15:47:18Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | waived | No live wrap was driven on an install: this checkout is the running server and restarting it is the operator's to authorize. The PR body states the live check is owed, and the #1927 branch stays held until it is done. |
| R-2 | note | filed | `2160` |
| R-3 | note | fixed-unreviewed | fixed in `docs/configuration-reference.md` |
| R-4 | warning | fixed | fixed in `docs/configuration-reference.md` |
| R-5 | note | filed | `2160` |
| R-6 | note | filed | `2160` |
| R-7 | warning | waived | `2155` |
| R-8 | note | fixed-unreviewed | fixed in `docs/adr/0002-wrap-pipeline-contract.md` |
| R-9 | note | accepted | Informational: the cross-check ran against the primary checkout's learnings and found nothing reintroduced. |
| R-10 | note | accepted | Informational: #2154 is OPEN on GitHub; the backlog cache predates it. |

**10 findings** (3 warning, 7 note) — accepted: 2, filed: 3, fixed: 1, fixed-unreviewed: 2, waived: 2.
**3 answered twice** — recorded as both resolved and dispositioned; check which answer is current.

**After the review, on the Architect's ruling on PR #2161.** R-2 was first filed under #2160, and the Architect ruled it belongs in this PR. The table above still shows it as filed, because the disposition record takes a fix only where no review round was needed; the rewrite was covered by review `rev-20261007T155501Z-54159c4b` (0 blocking, 0 findings), and #2160 carries a comment that this item is done: `test/wrap-secret-check.test.js` still carried a case titled for the reversed #1406 rule, built on a hand-made classification `classify` can no longer produce. It is rewritten on a classification `classify` returns, and split in two: a clean left file is still read and reports no match, and a flagged left file is still named in the report. The derived-lists refactor and the stale JSDoc stay in #2160.

## 2026-10-07 — #1937: advisory is the default recovery mode where the login is in force

<!-- prawduct: type=feature | scope=1937-default-flip -->

#1937 Chunk 04b, on the PM's dispatch (Medusa `74a6a092`), to the plan the Architect approved at revision 3. The Operator ruled on 2026-10-06 that advisory is the default; the Architect ruled on 2026-10-07 that it must not be the effective default where nothing can say who the operator is.

**The change.** A project with no operator decision on record resolves `advisory` while the login gate is `armed` and `operator` in every other state. `lib/recovery-default.js` owns that answer and carries the gate state with it; `server.js` installs its probe once the listener is bound, built from the listener and not from a request. `lib/project-config.js#resolveRecoveryMode` takes the answer as a boolean and stays free of a store or gate dependency. The launch reads the gate once, beside the operator's decision, and freezes the result.

**Departure from the parent plan, recorded.** Its section 3.3 flipped the seeded constant to `advisory`. The constant stays `operator`: every save writes it into `project.json`, and a file saying `advisory` is a request that is refused with a warning where the login is not in force.

**Tightened.** A file saying `advisory` with no decision on record no longer chooses advisory unless the gate is `armed` (Architect, approved). The file is in the project's checkout, where its session can write it.

**What a held launch is told.** One function, `operatorHeldHint`, writes the sentence the withheld step, the READY refusal, the unready nudge and `tc start status` print. Why comes from the project's live mode and source; what can be done comes from the gate state at the moment of asking. The Architect's blocking correction to revision 1 was that every non-`armed` state had been described as "no login" and pointed at a clear the route refuses in four of them. The PM's correction to revision 2 was that the open-install clear is reproducible by a local process, not refused; the sentence there names no operator and claims no proof.

**Found while building, and decided.** `load` hands a project with no file the seeded block, so "no file" and "saved long ago" both read as `inherited`, and the plan's notice ("this project moved from operator-cleared") would have been false for a project that never launched. The notice now says what the project's launches do from here on. It is served from the marker the claim wrote, which names the launch, so it needs no snapshot field.

**Tests.** Both install modes through the real launch path, every gate state from `GATE_STATES`; the gate and the decision each read once, held by a probe that changes its answer after its first call; each hint held against the real clear and readback routes in all six gate states, with the two open-install request shapes driven separately; the real probe on a real listener. Existing fixtures that reached advisory through the file alone now record the operator's decision, as the PATCH does; no assertion was weakened. A mutation pass over each mechanism added went red on every case.

**Carried in from earlier reviews.** The comment above the project-scoped 404 on the reconciliation route now describes the caller that reaches it; "pinned before advisory becomes the default" is gone from `test/advisory-ready-audit.test.js` and its `FEATURES.md` entry. The `project.recovery-mode-decided` event's `detail` is not touched: `lib/projects.js#updateProject` was not edited.

**Review.** Cumulative `rev-20261007T083228Z-a13e02bd`: 0 blocking, 5 warnings, 7 notes. Fixed in a docs-only commit: ADR 0017's "Alternatives considered" still called advisory-as-default refused and unsettled beside the R3 that settles it; and the docs promised the one-time notice without its two limits (a file whose `launchSequence` block has no `recoveryMode` key takes the default with no notice, and the notice is claimed when the launch is recorded, not when it is read). Filed as #2150: the launch does not record which gate state decided its frozen mode, the notice read's failure path has no test, a stale JSDoc, a duplicated predicate. Accepted: the probe install line in `server.js` has run only in tests of the probe it installs; its failure direction is operator-cleared, and the live check is owed after merge.

**After the PR opened (#2151).** The Architect approved both build-time decisions (PM Medusa `3ef4e590`) and required one copy fix: the notice ended "This notice is shown once", which is not true of a first launch that ends before its task step is served. It now says the notice belongs to the project's first launch under the default and is not repeated. A test pins the wording and that case.

## 2026-10-06 — #1937: the operator can read a launch's reconciliation

<!-- prawduct: type=feature | scope=1937-reconciliation-readback -->

#1937 Chunk 04a, on the PM's dispatch after the Operator approved the A24 exception. Architect ruling A83 made this a condition of the advisory default: the reconciliation a session writes was stored and returned to nobody.

**The change.** `POST /api/sessions/:project/launch/reconciliation` returns the stored text with its launch (sequence, attested revision, accepted-at, READY digest, preflight verdict, clearance) and the constant `provenance: agent-authored-unverified`. It runs `_requireOperatorWrite`, unchanged, which is why it is a POST, and serves only an `operator-verified` result. The Launch readiness panel gets a button on each attested row; the text is fetched on the click, escaped, labelled as the session's unchecked account, and long text sits in a `<details>`. `GET /api/launch-sequences` is not touched.

**Decision recorded in the plan.** A dedicated route over an operator-only field on the GET: that route's caller resolver reads any browser-shaped request on an open install as the operator, which a bound session can imitate with one header.

**Refused where there is no login (Architect, amending A83; PM Medusa `fc2a98ef`).** The first version served the operator proof's open-install result, and the cumulative review showed that a local process imitating a same-origin browser, with a page token it fetched itself, could read the text. The Architect ruled that a request's shape cannot satisfy "operator only". The route now serves only a proof result of `operator-verified`, so on an install with no login every caller gets `403 LOGIN_GATE_REQUIRED`, the dashboard included, and the panel shows a line in place of the button. Tests cover the dashboard's own request, an imitating process with and without a session's headers, and the exact request the recovery clear accepts. The documents do not describe this as a limit shared with the recovery clear: the Architect named that route's posture a separate question.

**Carried to chunk 04b by the same ruling.** Advisory is not to become the effective default on an install with no login; operator recovery stays the default there until a real operator identity check exists. Tests for the effective default on both install modes belong to that chunk.

**Also changed.** `test/api-coordinator-rotation.test.js` names the new route in the coordinator epoch-gate exemptions, with its reason: the roster guard, built from the registered routes, failed the first full run until it did.

**Review.** Cumulative: 0 blocking, 4 warnings. Fixed two leak channels that had no test (the server log, the Master on the launch list). Its warning that the documents said "sessions cannot read it" with no qualifier for an install with no login is what led to the refusal above. Two verify-resolutions rounds since, 0 blocking each. The duplicated operator-route preamble is filed as #2148. Owed after merge, on a live dashboard: press the button on an install with a login, and confirm an install with no login shows the line and no button.

**Split.** The default flip, the hint variants, ADR 0017's R3 rewrite and the contract-change tests are chunk 04b, in its own session, after this is on main.

## 2026-10-06 — #1937: the advisory READY path is audited and pinned by tests

<!-- prawduct: type=chore | scope=1937-advisory-ready-audit -->

#1937 Chunk 03, on the PM's dispatch. The Architect made this a condition of flipping the default recovery mode to advisory: a read-only audit of the advisory READY path, then regression tests for five named properties. Findings go to the PM before the default flip starts.

**The change.** Test-only. New `test/advisory-ready-audit.test.js` reaches recovery through the real preflight (a corrupt `current.json`, a crashed newest session, a handoff directory that cannot be read) and holds: a reconciliation is a string of real length after trimming, and stands in for neither the task step nor the verdict; the stored preflight, the files under the handoff path and earlier sessions' statuses are the same after the clear as before it; the clear is `agent-reconciled` with no operator, whatever fields the artifact carries, and READY never stamps it over a person's clear; a refused attestation, or a clear that cannot be written, leaves no attestation, clearance or event; and a launch keeps its frozen mode when the operator's decision changes under it, in both directions. No production code changed and the default is still `operator`.

**Evidence.** Twelve single-line source mutations in `lib/launch-sequence.js` and `lib/store.js`, one for each guard the tests rely on, each turned at least one of these tests red and were reverted.

**What the audit found.** No defect in the gate. Two things outside it, reported to the PM and not changed here: the reconciliation text is stored in the launch's READY artifact and no route, panel or command returns it to an operator; and `tc start status` still says an attestation "will need a reconciliation" on a launch that has already attested.

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
