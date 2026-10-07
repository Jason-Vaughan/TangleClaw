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

## 2026-10-07 — #2128: a launch sees an engine's startup dialog, types nothing into it, and names the cause

<!-- prawduct: type=bugfix | scope=2128-startup-dialog -->

#2128, single chunk, on the PM's dispatch (Medusa `17d6a6c9`) under Architect ruling A85 (Medusa `0693ed1e`). Design record and spike evidence: `.tangleclaw/plans/2128-folder-trust-prompt.md` in the Builder2 checkout.

**Root cause.** The issue said Claude Code's folder trust dialog timed out and exited. A live capture on 2.1.283 showed otherwise: the dialog waits indefinitely, its default option is "No, exit", and Enter on it exits with code 1 within a second. The session died because TangleClaw typed a line ending in Enter into a screen it never looked at. The cause was then lost by construction: a death is noticed by a later status read, which records the fixed string `tmux session died` in the activity log only, after the pane that explained it is gone.

**The ruling.** See and report, for every engine that declares a dialog; reject blind keys; write nothing to `~/.claude.json`; accepting trust on the operator's behalf is a separate later issue with per-project opt-in. This chunk is the seeing half only.

**The change.** `capabilities.startupDialogs` in the engine profile; `lib/startup-dialog.js` (detect, a one-read check, a bounded watch); the watch runs ahead of a launch's pre-keys, paste and kickoff; `injectCommand` makes the same check before every later send; `sessions.launch_blocker` (schema v57) keeps the named blocker past the pane's death and `markCrashed` carries it as `cause`.

**Two decisions taken while building.**
- A dialog matches only when no prompt row sits below it. Without that, a session whose transcript quotes the dialog (this one did, while the fix was being written) would refuse its own wake nudges.
- A boot window that recognises nothing lets the launch proceed as before. The alternative, withholding on any unknown screen, would turn every unrecognised engine update into a launch that never starts.

**A behaviour that moved.** Claude's prime is now pasted when the watch sees its prompt, not a fixed 2 s after launch. Six tests that drive a real Claude launch with no pane now state what the boot watch saw (`timeout`, the path a launch took before boot was watched): four delivery-ledger tests on a mocked clock and the two real-launch kickoff tests. Their assertions are unchanged. After the merge of main the migration is v56→v57, and the schema-version test that had to move is main's own.

**The sender, proven from the server log.** Session 1352 (TC-RM14, 2026-10-06T05:22:30Z): the kickoff answered `not-silent`, so the prime was pasted; at +2.1 s the paste's prompt clear logged "Cleared a draft from the prompt before injecting ... rows=1 chars=8"; by +8.6 s tmux no longer had the session; the status read at +20 s marked it crashed. "No, exit" is eight characters, so that draft was very likely the dialog's selected option; its bytes were not read, because the draft store is private. On that reading the blind paste took the selected option for an operator draft, cleared it, pasted, and its Enter confirmed the default. The "20 seconds" in the issue is when a status poll noticed, not when the pane died. Session 1353 repeats the signature. Tests pin both halves: the shared idle gate (kickoff, wake nudge, unready nudge) refuses the captured dialog, and `readComposerDraft` reads it as exactly that one-row, 8-character draft.

**What the review caught.** The stored blocker had no owner: set at a send or left by a watch that had stopped, it stayed on a healthy session and a later unrelated death was blamed on the dialog. One function now reconciles the record with the pane for every status read and every send. Two senders typed past the check (the wrap's content prompt and the Critic action call `tmux.sendKeys` directly), which made "every later send" untrue; the refusal moved into `tmux.sendKeys`, and a source test requires every caller to name its engine. A live session at the dialog was shown nowhere; the card and the session page now say so.

**Second review, after the merge of main.** The reconcile cleared a blocker on any read that matched no dialog, and tmux's reader answers a failed capture with no lines at all, so a failed read could drop the one record that explains the crash about to follow. The check now answers three ways (a dialog, a positive prompt reading, or neither), only the positive reading clears, an empty read counts as unread, and a half-drawn frame is read once more before a send.

**Architect review of the PR (HOLD, then these changes).** The reconcile kept a stored blocker on an unreadable, empty or undecided pane, but the senders refused only on a dialog they could see, so a later command could still type into a trust dialog the read had missed. A stored blocker now withholds every send until a positive prompt reading clears it, on the API path, the wake path and in the pane writer. A frame still carrying a declared marker after its one re-read withholds the send too, instead of failing open. The docs no longer say the pane-writer floor covers raw keys or a caller that names no engine. A dialog reworded past every declared marker stays a stated detection limit.

**Live check, 2026-10-07, Claude Code 2.1.283, empty scratch repo, trust not accepted.** The real boot watch reported the real dialog 8.4 s after launch with no false "clear" first, the one-read check saw it, `tmux.sendKeys` threw `STARTUP_DIALOG`, the pane was still at the dialog afterwards with nothing typed, and declining wrote no trust entry. Not run live: the path after the operator accepts (it would need a second acceptance, which the ruling did not grant); the spike's capture after acceptance showed the composer with no dialog text. Not run: a launch through a TangleClaw server, which this lane may not start.

**Normal-launch latency, measured.** In a trusted scratch repo at load average 31 to 33, Claude Code drew nothing for 16.6 s and 21.2 s, and the watch called the prompt settled 0.6 s after it first appeared (three watched runs: 18.2 s, 19.5 s, 23.4 s). So the wait is the engine's own boot plus one settle tick; the old path pasted at 2 s into a pane that had drawn nothing. The watch reads through the non-blocking pane reader, because one synchronous read cost 120 to 170 ms at that load.

**Found in the same log.** Those launches ran on `claude-sonnet-reviewer`, an operator-made profile for the `claude` command that exists only in `~/.tangleclaw/engines`. The bundled-profile sync never updates it, so a declaration read per profile would have left the reported launches unprotected. A profile with no list of its own now takes the dialogs declared for the command it runs.
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
