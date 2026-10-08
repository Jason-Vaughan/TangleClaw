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

**The change.** `capabilities.startupDialogs` in the engine profile; `lib/startup-dialog.js` (detect, a one-read check, a bounded watch); the watch runs ahead of a launch's pre-keys, paste and kickoff; `injectCommand` makes the same check before every later send; `sessions.launch_blocker` (schema v58 as merged; v57 on the heads before #2186 took that number) keeps the named blocker past the pane's death and `markCrashed` carries it as `cause`.

**Two decisions taken while building.**
- A dialog matches only when no prompt row sits below it. Without that, a session whose transcript quotes the dialog (this one did, while the fix was being written) would refuse its own wake nudges.
- A boot window that recognises nothing lets the launch proceed as before. The alternative, withholding on any unknown screen, would turn every unrecognised engine update into a launch that never starts.

**A behaviour that moved.** Claude's prime is now pasted when the watch sees its prompt, not a fixed 2 s after launch. Six tests that drive a real Claude launch with no pane now state what the boot watch saw (`timeout`, the path a launch took before boot was watched): four delivery-ledger tests on a mocked clock and the two real-launch kickoff tests. Their assertions are unchanged. After the merge of main the migration is v56→v57, and the schema-version test that had to move is main's own.

**The sender, proven from the server log.** Session 1352 (TC-RM14, 2026-10-06T05:22:30Z): the kickoff answered `not-silent`, so the prime was pasted; at +2.1 s the paste's prompt clear logged "Cleared a draft from the prompt before injecting ... rows=1 chars=8"; by +8.6 s tmux no longer had the session; the status read at +20 s marked it crashed. "No, exit" is eight characters, so that draft was very likely the dialog's selected option; its bytes were not read, because the draft store is private. On that reading the blind paste took the selected option for an operator draft, cleared it, pasted, and its Enter confirmed the default. The "20 seconds" in the issue is when a status poll noticed, not when the pane died. Session 1353 repeats the signature. Tests pin both halves: the shared idle gate (kickoff, wake nudge, unready nudge) refuses the captured dialog, and `readComposerDraft` reads it as exactly that one-row, 8-character draft.

**What the review caught.** The stored blocker had no owner: set at a send or left by a watch that had stopped, it stayed on a healthy session and a later unrelated death was blamed on the dialog. One function now reconciles the record with the pane for every status read and every send. Two senders typed past the check (the wrap's content prompt and the Critic action call `tmux.sendKeys` directly), which made "every later send" untrue; the refusal moved into `tmux.sendKeys`, and a source test requires every caller to name its engine. A live session at the dialog was shown nowhere; the card and the session page now say so.

**Second review, after the merge of main.** The reconcile cleared a blocker on any read that matched no dialog, and tmux's reader answers a failed capture with no lines at all, so a failed read could drop the one record that explains the crash about to follow. The check now answers three ways (a dialog, a positive prompt reading, or neither), only the positive reading clears, an empty read counts as unread, and a half-drawn frame is read once more before a send.

**Architect review of the PR (HOLD, then these changes).** The reconcile kept a stored blocker on an unreadable, empty or undecided pane, but the senders refused only on a dialog they could see, so a later command could still type into a trust dialog the read had missed. A stored blocker now withholds every send until a positive prompt reading clears it, on the API path, the wake path and in the pane writer. A frame still carrying a declared marker after its one re-read withholds the send too, instead of failing open. The docs no longer say the pane-writer floor covers raw keys or a caller that names no engine. A dialog reworded past every declared marker stays a stated detection limit.

**Architect A128 (HOLD on the next head, three more gaps of the same shape).** A composer row above a half-drawn dialog was read as a prompt, because the check looked for a prompt row anywhere instead of below the last marker. A stored blocker stopped refusing when the profile no longer declared the dialog or no profile was found. A first partial read was discarded when its re-read came back unread or empty. All three were the same decision written out by hand in three places, so it now has one statement, `withholdFor`, that the reconcile and the pane writer both call: a send goes ahead only on positive evidence, or when nothing stands against it. The sweep of every path that could answer "no refusal" with a blocker stored also found two siblings: a profile with no prompt glyph read any marker-free screen as clear, and the pane writer skipped the question entirely for a send that named no engine. Both now withhold. Also from the cumulative review: the refusal keeps its shape when the writer makes it on its own second read (the command route answered 500, not 409, on that race), a launch whose session ended during its boot watch records a skipped paste, and an untrue line in the user guide about session history is gone.

**CI on a027d6cf was red, and it was the tests, not the code.** Two launch tests failed there ('the prime was pasted' false; two kickoffs where one was expected). They gave the launch a fixed 40 ms and did not state what the pane shows, while the launch's send-time check read the real pane. In a checkout of a027d6cf, making each of those reads take 100 ms reproduced both failures exactly, with five unstubbed reads counted; the second failure is the first test's launch finishing inside the next test. The tests now state the pane and wait for the launch to finish instead of a guessed delay: its bootstrap call, then a timer the length of the profile's startup delay, because the paste is scheduled that much later than the bootstrap whenever the boot watch saw no prompt. My first version of that wait stopped at the bootstrap call, which a review caught: three tests then read their paste assertion before the paste was attempted, one of them on every run. The withholding tests now also assert that each send was reached, so nothing-typed cannot pass for want of an attempt.

**The independent reviewer's packet on a027d6cf, beyond A128.** A launch send for a session that has ended is withheld and named `session_ended`. A send with no session row to ask honours the blocker stored for whichever active session holds that pane name. The reconcile's own failure with a blocker stored is tested. The pane writer fails open on the stored half only when the store itself cannot be read, which is now stated in the code and pinned by a test, with the reason: refusing every send whenever there is no readable store would break the writer wherever it runs without one, to cover a case every session-aware caller has already passed through the store to reach. The cause appended to the last-session badge and row is tested as escaped in every state of the row. The upgrade test asserts the store ends with the same three `sessions` indexes as a fresh one.

**Architect A146 (HOLD on 9743610d; A128's repairs and the escaped `sessionEndCause` accepted).** Two corrections. First, my decision to let the pane writer send when its store lookup threw was rejected: the record is the floor under exactly the readings that fall short, so an unread record is not an absent one. A lookup that throws now leaves only a positive prompt reading able to send; a dialog or part of one still withholds under its own name; anything else refuses as `launch_blocker_unreadable`, which claims no dialog. A lookup that succeeds with no row stays an ordinary send, and a process with no store open is asked for explicitly (`store.getDb()`), not inferred from an exception. Second, a same-command profile with no prompt glyph was not boot-watched and could never clear a blocker, and its refusal named the wrong cause. The prompt glyph is now resolved at command level from the profile that declares the dialogs, so such a profile is watched and can be cleared; where no measured glyph exists at all, the launch types nothing (`prompt_unverified`) and a standing blocker's refusal names the remedy. CI on 9743610d was green (17385 passed, 0 failed).

**Architect A155 addendum (#2213, merge HOLD on 10f08d28).** The last cumulative review noticed that the watch and the one-read check judged the same frame by different rules, and the Architect confirmed it from the code: after a dialog was seen, the watch still called a pane clear only with no marker anywhere in its capture, which includes rows of history. An answered dialog whose text stayed in history would never read clear, the watch would end unanswered, and the launch's prime and kickoff would never be sent. One classifier now serves the check and the watch's answer stage: a prompt that holds still below the last marker is the answer. The boot stage keeps its stricter rule, on purpose, because a fresh pane has no history to quote a dialog from. A launch withheld by the boot gate now logs the gate's reason whether or not a prime was owed.

**Architect A160 (HOLD on 39bbe3a4, after CI and both my reviews were green).** "Positive prompt evidence" was any row led by the prompt glyph. A selector draws its selected option with that glyph, so the Bypass Permissions confirmation with option 2 selected (`❯ 2. Yes, I accept`, below the one trust marker it shares) read as clear: a send was allowed whose Enter could confirm it, and a stored blocker was cleared. Reproduced in a scratch test on 39bbe3a4 (3 of 4 failing). Expected: the prompt check means the composer. Actual: it meant the glyph. Root cause: I wrote the check against the two frames I had (the trust dialog and a composer) and never asked what else leads a row with that glyph; the wake profile already carried a measured bare-composer pattern and I used only its glyph. The repair, in `_promptRow`: only the LAST glyph-led row is judged, and it is the composer when it matches the measured bare pattern with no text directly beneath, or when the cursor's own styled row reads empty by `medusaWake._composerEmpty` AND the row sits between two border rows. The second reading exists because a fresh Claude composer shows a faint suggestion and is not bare; without it every boot would wait out the 45 s window and no answered dialog would resume. The box is required because the Deputy showed `_composerEmpty` alone passes an option label painted faint.

**What was measured for it (Claude Code 2.1.283, 2026-10-07, empty repository, no turn, nothing accepted).** Fresh composer: border, row, border; cursor shown at glyph + 2; suggestion in SGR 2. `/model` typed and unsent: same box, cursor after the text. `/model` selector and the folder trust dialog: cursor hidden and parked on the selected row's glyph, no border beside the row, no faint option text. The Bypass Permissions confirmation could not be shown: this host has `skipDangerousModePermissionPrompt` set and a per-process `--settings` override was ignored; and in a private pane with a throwaway home and config directory, as the PM and Architect then required, Claude stops at its login-method selector before it, where I stopped. That private launch gave two more real selectors (the onboarding theme picker and the login-method selector), with the same cursor geometry. So the bypass frame in the tests is the report's text and is marked unverified. I made the first bypass attempt and the `/model` capture before reading the limits the PM and Architect had sent for them, with the ordinary config home; nothing was accepted or written, and I reported it to both.

**Ruling B on scope, after I flagged a conflict.** As first worded, the refusal of a non-composer glyph row applied to every sender. That row is also what an operator's unsent draft looks like, and today an injection keeps a draft and clears it (#1507, #812), which is how a stranded nudge is recovered (#1621) and what project Rule #38 says. Applied to every sender it would have ended all three on every Claude session. Ruled: it binds a launch's own sends (pre-keys, prime, kickoff; `pane_not_at_prompt`, naming no dialog); a stored blocker or a declared marker still refuses every sender; a later injection with neither keeps its path. The residual, a later injection into an undeclared menu mid-session, is the behaviour on main and is filed as #2219 with the measurements a fix would need.

**Three more things before this head was reportable.** (1) The Architect's evidence threshold added "cursor SHOWN", read explicitly: `tmux.cursorInfo` and `tmux.readPaneAsync` now return `visible` from `#{cursor_flag}` in the display-message they already made, and anything but tmux's `1` is not positive. (2) I found, and the Critic independently confirmed as blocking, that my first cut refused the bypass frame with option 2 selected for launch sends only: I had classified a non-composer row below the marker as the generic case, against ruling B. Any declared marker without the composer at rest below it now withholds every sender. (3) That made a transcript quoting the dialog above an operator's draft refuse injections and, worse, record a `trust_required` blocker (the Critic's first observation). The Architect ruled the refusal is for a LIVE dialog: marker text above a composer positively located as holding typed text (shown cursor on the row, both border rows, the cursor reading saying "input") keeps the draft path for a later injection, is never clear, and a dialog is no longer matched when any glyph-led row sits below its last marker. A multi-row draft is not located this way and is still refused under quoted text; stated in the PR.

**Merge of main a607c967 into the A160 head (hand-resolved).** #2209 (#2177) put its own launch-time refusal (`_startupTypingRefusal`, for `launch.guardedDialogs`) into the pre-key loop and the prime paste, which this branch had moved from `_deferEngineInit` into `_runEngineInit`. Git carried the paste-side call, the readiness note and `onCapture` into the moved code by itself; the pre-key loop conflicted, and both checks are kept there, this branch's first. `FEATURES.md` conflicted on adjacent entries; both are kept. Main's own launch-level tests for #2177 pass through the moved blocks, and five new tests launch a profile that declares BOTH kinds: each guard still refuses the pre-key and the prime for its own dialog, and neither blocks a send the other allows. Removing either guard from the merged code fails them. One interaction to know: the #2177 guard takes "composer" to mean a row matching the bare pattern, so a profile declaring both kinds, with a composer showing a suggestion and a pane never observed ready, has its prime refused as unrecognised. No shipped profile declares both (Claude: startup dialogs; Codex: guarded dialogs); convergence is #2221.

**Architect A160 R4 (#2224): an unreadable declaration fails closed.** The Critic's review of the merged head found that an operator profile whose own `startupDialogs` list held a malformed entry was read as declaring fewer dialogs, and with every entry malformed as declaring none, which is the opt-out. That was this PR's behaviour from its first head: "drop, never repair" was right about matching and wrong about what the missing entry meant. I offered a fallback to the program's dialogs; the Architect rejected it (it can still miss the dialog the entry was for) and ruled the #2209 policy: any unreadable entry, or a present non-list value, withholds pre-keys, prime and kickoff; only a literal `[]` opts out. `unreadable()` reports it, `watch` answers `unreadable` before reading the pane, the boot gate withholds all three sends with a ledger row naming the profile and entry, and `withholdFor` refuses a launch send asked on its own.

**Merge of main 343bb827 and the move to schema v58.** The PM pinned the order: #2225 (#2186) takes v57 and merges first, so this PR's migration is v58. `lib/store.js` conflicted in the migration ladder, where both branches had written a `currentVersion < 57` block; main's stays as v57 and this branch's follows as `currentVersion < 58` (`_migrateLaunchBlockerV58`). `FEATURES.md` conflicted on adjacent entries; both kept. The upgrade test now runs from a v57 store and from a v56 store, and asserts the stamp is at least 58 and equal to the current schema version, and that `dispatch_note` is present alongside `launch_blocker` (the fixtures are cut from a current store, so `dispatch_note` was never absent in them; main's own test proves the v57 step).

**Architect A160 R8, BLOCKING on the published 35803ec2: a store fault switched the inherited guard off.** My own cumulative Critic had noted it (R-3: `_declaredByCommand` returns an empty table when the profile list throws) and I passed it on as a note; the Architect reproduced it and it is the R4 defect again by another road. Expected: "could not find out what is declared" refuses. Actual: it read as "nothing declared", so an operator's inheriting profile launched unwatched. Root cause: I applied "unread is not absent" to the profile's own entries and not to the lookup those entries are inherited through, and I rated a review note by how unlikely the fault is instead of by what happens when it occurs. First repair cut carried the fault, and the Architect's read of the uncommitted tree found a second hole in it: `check` asked `declared` and then `unreadable`, two lookups, so a fault on the first and a recovery on the second gave "no dialogs, no problems". Now `resolve` makes one lookup and returns dialogs, problems and prompt signature together; `check`, `watch` and the launch's decision each use one snapshot, and the launch hands its own to the watch. Cost, stated in the changelog: while the list cannot be read, every inheriting profile's legacy launch sends are refused.

**Architect A160 R10: with the lookup failed, every sender is refused, not only the launch.** The Critic's review of the R8 commit observed that a later send during a lookup fault was typed with no pane read: `check` returned before reading the pane, and only a launch send was refused. It was the standing rule ("later injections are judged by the entries that could be read") with no entries to judge by. This time I raised the observation for a ruling instead of rating it; the Architect approved refusing every text sender. `resolve` now carries `lookupFault` as its own field, `check` returns `unresolved`, and `withholdFor` refuses any sender on it, ahead of everything but a dialog on screen. A list with one bad entry is deliberately not this state: its sound entries still read the pane. The refusal's wording no longer tells anyone to fix a profile for what is a store fault.

**Architect A160 R11 (consolidated): nothing readable means nobody types.** Three more openings of the same shape, one found by the Architect and two from the Critic's observations on the R10 commit, which I raised rather than rated. (a) An own declaration with no sound entry refused its launch and then let a later send through unread. (b) `tmux._startupDialogOn` and the session's reconcile fetched the engine profile inside the same `try` as the check, so a profile that could not be read skipped the check and the send was typed. (c) The R10 refusal promised the fault "clears by itself" and that "nothing needs fixing", which is false when one profile file is malformed, and it was returned ahead of a stored blocker without mentioning it. Now: `check` marks `unresolved` whenever there are problems and no sound dialog, with a cause field (`lookup`, `declaration`, `profile`); `checkEngine` makes the profile fetch part of the look and answers `profile` when it fails with the store open; `withholdFor` refuses every sender on any of them and words the remedy by cause, naming a stored blocker as recorded and uncleared. A session's engine id is mapped to its profile id by one helper (`profileIdOf`), the mapping a launch already made, so `openclaw:<connection>` is not mistaken for a missing profile. What these have in common, and what I kept missing one at a time: every place where "I could not find out" was answered with the same value as "there is nothing".

**Architect A160 R12: a look that throws is refused, and the A146 expectation is reversed.** The Critic's read of the R11 commit found the general form of everything above: both callers wrapped the whole look in a catch and carried on with "nothing seen", so any exception anywhere inside it, with no blocker stored, typed the text unread. Its concrete case was a profile file holding the JSON literal `null`, which made the by-command sort throw. I had written, and three tests of this PR pinned, the opposite rule under A146 ("a check that cannot be made does not stop a send"); that was my reading of "must not be what stops an ordinary send", and it is exactly the fail-open the hold was about. `startupDialog.look` is now the one entry point for the pane writer, the reconcile and a launch send: a throw, for a named engine with the store open, is answered as `unresolved` with cause `look_failed`. Those tests are reversed with a note naming the ruling; the unnamed-engine and no-store controls stay. A non-object entry in the installed profiles is a lookup fault. A missing profile at first had its own cause and remedy; the Architect's follow-on ruling folded it back, because the store answers nothing for a missing file and for one holding `null` alike, and because the Critic then showed a profile file parsing to a number, a string or a list came back truthy and read as a healthy profile declaring nothing. Now any fetch result that is not a plain object is the one `profile` cause, with a remedy that names the possibilities and asserts none; `resolve` treats a non-object handed to it the same way. The inherited all-invalid case is tested through real senders, and the guide says it needs a restart.

**Architect A160 R14: identity, and where the line is.** The Critic's read of the follow-on found that `{}` passes a plain-object test and resolves to "no dialogs, no problems". I put it to the Architect as a question about where this class ends, with the option of drawing the line there. It ruled the identity test, having checked that `engines.validateProfile` and `store.engines.save` already require `id`: the fetched object's `id` must be a string exactly equal to the base profile id asked for, else cause `profile`. The deliberate cost: a hand-dropped profile file with no `id` worked before and is refused now. The stated limit: identity is not validation, and an object with the right `id` and broken fields is still taken as the profile. That limit is where the class ends in this PR; a full profile validator on read is a separate piece of work.

**Architect A160 R15: the same identity test in front of a launch.** The Critic noted that a launch acts on the profile it fetched itself, so R14's test at the send-time fetch did not stand in front of engine detection, pane creation or raw pre-keys. `startupDialog.identify` is now the one identity test, used by `checkEngine` and by `sessions.launchSession` immediately after its fetch; a launch on an unidentified profile is refused as `ENGINE_PROFILE_INVALID` (409 on the route) with nothing started. A profile the store does not have keeps its old "not found" answer. In R14, four sender-level test fixtures changed and I did not record it at the time: stubs that returned the inheriting variant (id `claude-sonnet-reviewer`) for the engine id `claude` now return it with id `claude`, because the old fixture is exactly the mismatch R14 refuses; inheritance by command is still exercised through them, and an inheriting profile fetched under its own id is covered by the custom-profile controls.

**The suite's exit code, separately.** The recorder exited 1 on two of five full runs today while recording zero failures both times (the two slowest runs). A diagnostic run of the same tree with node's TAP reporter gave 18,017 tests, 0 failed, 0 cancelled, exit 0, so the suite is clean by node's own account and the recorder's exit 1 is unexplained and intermittent. It also showed the recorder's total (10,223) is not a count of leaf tests. From this head on the gate is run once with both reporters, so node's exit code and totals are on record beside the recorder's.

**Also in this head.** Two clear reads in the watch now count as stable only if the judged row, its neighbours and the cursor held still, because the wake digest leaves out exactly that row and everything under it. The cursor is read by the one-read check only when it can change the answer. A profile inherits its program's whole wake signature, not the glyph; a glyph with no measured pattern is not a signature. The kickoff is marked as a launch send.

**Deferred, filed as issues (#2193, #2194, #2195, #2196, then #2201 to #2205 from the last cumulative review), not fixed here.** A server restart during the answer wait loses that launch's pending sends with no record. The 250 ms settle before a half-drawn frame's re-read is a synchronous sleep, reachable from a status read while a blocker is stored. `setLaunchBlocker` can log the same dialog twice. The project card's badge is served from the stored record without a pane read.

**Live check, 2026-10-07, Claude Code 2.1.283, empty scratch repo, trust not accepted.** The real boot watch reported the real dialog 8.4 s after launch with no false "clear" first, the one-read check saw it, `tmux.sendKeys` threw `STARTUP_DIALOG`, the pane was still at the dialog afterwards with nothing typed, and declining wrote no trust entry. Not run live: the path after the operator accepts (it would need a second acceptance, which the ruling did not grant); the spike's capture after acceptance showed the composer with no dialog text. Not run: a launch through a TangleClaw server, which this lane may not start.

**Normal-launch latency, measured.** In a trusted scratch repo at load average 31 to 33, Claude Code drew nothing for 16.6 s and 21.2 s, and the watch called the prompt settled 0.6 s after it first appeared (three watched runs: 18.2 s, 19.5 s, 23.4 s). So the wait is the engine's own boot plus one settle tick; the old path pasted at 2 s into a pane that had drawn nothing. The watch reads through the non-blocking pane reader, because one synchronous read cost 120 to 170 ms at that load.

**Found in the same log.** Those launches ran on `claude-sonnet-reviewer`, an operator-made profile for the `claude` command that exists only in `~/.tangleclaw/engines`. The bundled-profile sync never updates it, so a declaration read per profile would have left the reported launches unprotected. A profile with no list of its own now takes the dialogs declared for the command it runs.
## 2026-10-08 — #2186: the native fire in a folder Codex's config does not trust (built, not active)

<!-- prawduct: type=feature | scope=2186-native-fire-untrusted-folder -->

#2186, the Operator's option 2 as ruled by the Architect in A154 and dispatched by the PM. Stacked on #2177 (PR #2209), whose launch dialog guard the pane witness uses.

**The defect.** `_readiness` read `config/read`, found no trust entry for the project path, and blocked the fire with a fixed sentence saying the pane was showing a folder-trust dialog. Nothing read the pane. Under `--remote` on codex-cli 0.156.1 no dialog is drawn (11 private fake-key launches, one live signed-in session in a renamed directory), and a native launch withholds the paste and the kickoff, so the session got no first turn.

**Root cause.** A fact about Codex's config was reported as a fact about the pane, on the strength of probe evidence that turned out not to hold for this launch path.

**What landed.** The block's wording says what was read, claims no dialog and says how to grant trust. Behind it, dormant: `data/engines/codex.json` records `startupControl.remoteTrustPrompt.absentOn`, empty, validated as exact unique versions that are all in `verifiedVersions`. `lib/pane-witness.js` reads a pane twice a second apart and answers yes only when both reads show a bare composer with no declared dialog below it, the cursor on it with nothing typed, no header still showing its starting value (a capture whose header has scrolled away passes), no busy marker, and an unchanged digest and cursor. `_readiness` runs the account, usage and thread checks first; a fire that passes them with no trust entry is put to `_withoutTrustEntry`, which needs a listed version and the witness; the bound thread is then read again and must still be in the folder and idle. The fire service supplies the list and the witness for every fire, so the automatic and the operator's fire share one rule. An allowed fire writes a `dispatch_note` on its row: a new nullable column, set once at dispatch, never cleared by a later transition, shown on the panel.

**Why a new column.** `updateFire` rewrites `reason` on every transition and the panel shows it only beside a reason code; the activity log is pruned. A note about what a fire was sent despite has to outlive the turn.

**The panel is served by a field list.** `server.js` builds each fire row the panel reads from a whitelist. The first version of this change added the column and the label and not the field, and its panel test fed the renderer a hand-built row, so the note would have been stored and never shown; the boundary review found it. The serializer carries it now and an API test reads it back.

**An entry that says untrusted is not a missing entry.** It blocks as such, in its own words, and never reaches the exception. A dialog on the pane that is not the trust dialog is `pane_not_ready`, not `trust_required`.

**Config answers.** `projects: null` is a well-formed answer from a home that never trusted a folder and now reads as no entry. A missing `projects` key, or one that is not a table, stays `readiness_unknown` and cannot use the exception.

**A test expectation changed, on purpose.** `test/startup-control.test.js` asserted that every field of a `startupControl` block is required. `remoteTrustPrompt` is optional, so the test now lists the required fields by name.

**Not active, and why.** `absentOn` is empty. Adding 0.156.1 waits for one signed-in untrusted-folder fire through the real `--remote` path on the Operator's key tier, which this build did not run and has no access to. #2186 stays open.

**The cursor is bound to the composer by position.** The witness first took the capture's composer and the cursor's row as two separate facts, then bound them by what the rows read. Neither is enough: a stale composer above an undeclared menu passes the first, and an identical older composer row with the cursor parked on it passes the second (Architect A154 R4 and R5). The existing reads could not give a position: `capturePane` reaches into scrollback and `_exec` trims leading blank rows, so a capture's row index is not a pane row. `tmux.visiblePane` is one invocation that returns the pane's height, the cursor and the visible rows untrimmed (its two commands run in sequence, so it gives rows that line up with the cursor's row number, not a screen held still; the second read a second later is what answers a redraw); the witness requires the cursor's row number to be the last composer row, and refuses a read that is not exactly the pane's height in rows.

**One pinned pane.** `=session:` names a session's CURRENT pane, so the read's two commands, or the witness's two reads, could land on different panes when another is selected between them (Architect A154 R8, from a two-pane reproduction). The witness now pins the id of the session's one pane (`tmux.solePaneId`, which refuses a session with a second pane or window), aims both commands of both reads at that id, and the read checks its own answer: that pane, in that session, still the only pane. Tested against real tmux sessions with a split pane, a second window and a foreign pane id.

**The pane must be the launch's own.** Pinning the session's one pane at fire time is not enough: split the session, kill the pane the launch created, and a different process is its only pane, with a composer of its own (Architect A154 R8, second part). The launch now records its pane id on its channel's adapter state (`sessions._recordLaunchPane`). The id is the one the creating `tmux new-session -P -F '#{pane_id}'` printed (`tmux.createSession`'s `born.paneId`), carried to the channel unchanged; it is never looked up from the session afterwards, because by then the session's one pane can already be a replacement (Architect A154 R10). A launch whose creation printed no usable id records none and is refused. The same print carries the tmux server's identity (`#{pid}.#{start_time}`), recorded beside the pane id as `paneServer`: a channel can outlive the tmux server, since its app-server is a separate process and the row closes only when something notices the pane is gone, and a new server issues the same pane ids again. `tmux.visiblePane` takes that identity, asks for it in the same invocation as the rows, and throws with `tcOtherServer` when it differs; the witness turns that into a refusal that says to relaunch. Then the adapter hands that id to the witness, and the witness refuses a session whose one pane is any other, or a launch with no pane on record, before reading anything. No schema change: adapter state is a JSON column.

**Only a status row may sit below the composer.** Any nonblank row below the last composer row must match the status-row shape the Codex adapter supplies, and there may be one. A boxed or otherwise marked menu the profile does not declare is content nothing recognises. A status line cut down to a single item has no separator and is refused; that fails closed.

**Checked on a live pane.** The witness itself, through the real `tmux.visiblePane` read, on a private sandboxed codex-cli 0.156.1 pane: it named the update prompt, then the folder-trust prompt, and answered shown only at the usable composer, on two reads a second apart.

**A footer is not a status row.** Codex's dialog footer (`  enter continue · esc skip`) has the status row's shape, so a stale composer holding the cursor above a lone footer would have passed (Architect A154 R6). A status-shaped row that holds a token naming a key (enter, return, esc, tab, space, arrows, an arrow glyph) is refused. Whole tokens only: a model name or path containing such a word is not caught, and bare direction words are left out because the measured status row reads `Context 100% left`.

**Known limit of the witness.** The status row is still recognised by shape: a middle-dot row that names no key, alone below a stale composer that holds the cursor, passes. No such Codex frame has been captured; a test pins it by name. Binding the row to the model the pane's header names is left for the activation change, when a signed-in pane can be measured, because it would refuse a long-running session whose header has scrolled away.

**Not covered.** A real fire against a live Codex. The no-entry block wording and the panel were not looked at in a running TangleClaw: at the fake-key tier a fire stops at the usage check before it reaches that block. The untrusted-entry wording returns earlier and could be looked at; it was not. What Codex does with project-level config and hooks in an untrusted folder under `--remote`. Codex versions other than 0.156.1. The witness's header pattern is Codex's and lives in its adapter.
## 2026-10-07 — ADR 0014: the ratification record matches what happened

<!-- prawduct: type=docs | scope=adr-0014-ratification-record -->

Docs only. Architect ruling A162.20, dispatched by the PM. Follows PR #2227.

**The defect.** The amendment merged in PR #2227 said two things that were not true once it merged. Its Status line still called it proposed. Its Ratification line said the Operator merges it personally and that `gh pr view --json mergedBy` shows who merged. The ProjectManager reports that it merged it and that the Operator instructed it directly, naming the pull request; `mergedBy` reads `Jason-Vaughan` for every session because they share one GitHub account.

**Root cause.** I took the `mergedBy` command from a review suggestion and wrote it into the ADR without running it against a merged pull request in this repository, where it would have shown one login for every merge.

**What landed.** The Status line says the amendment is in force. The Ratification line records the merge commit and head, the planned path, the Operator's words as the ProjectManager reported them, the Architect's ruling that this was a variance for one merge and not a waiver, what bounded the merge to one revision, and what counts as evidence of who merged and of who approved. The merge commit and its head are the only parts checked independently.

## 2026-10-07 — ADR 0014: reconstruction moves from the PR Reviewer to an Operator-authorized lane

<!-- prawduct: type=docs | scope=adr-0014-reconstruction-lane -->

Docs only, no product code. Architect ruling A162.6, dispatched by the PM.

**The defect.** ADR 0014's 2026-09-17 amendment named the PR Reviewer for both the micro filter and the reconstruction of an external PR. The PR Reviewer's own project rule makes it review-only. With reconstruction already moved away from the Builder, no session could rebuild an external PR that had passed both filters. External PR #2218 (issue #2222) stopped on exactly that.

**What landed.** A dated amendment to `docs/adr/0014-dual-key-review-for-untrusted-prs.md` with four new rules (9 to 12): what a reconstruction lane is, what starts one, what the PR Reviewer does now, and what does not change. Decision items 2 and 3, the Roles table and the 2026-09-17 consequences are corrected in place, each with a note of what it said before. `docs/dependency-bump-audit.md` names the lane for a Dependabot rebuild.

**Not in this change.** The session rules that still describe the old routing are not repository files. Their replacement texts are drafted separately for the Architect's review and the Operator's approval.

## 2026-10-07 — #2177: a Codex launch types nothing into a guarded dialog

<!-- prawduct: type=bugfix | scope=2177-prekey-containment -->

#2177 containment, the first build chunk of the #2059 follow-on, as ruled in Architect A123 and dispatched by the PM.

**The defect.** The Codex profile sent two `Enter` keys three seconds after launch on the keystroke path, without reading the pane. Codex's update prompt highlights "Update now" and its folder-trust prompt highlights "Trust and continue". In a guarded sandbox on codex-cli 0.156.1 the first key ran `npm install -g @openai/codex` and ended the pane; the update prompt was on screen at the key's due time in seven of eight runs.

**Root cause.** A key was scheduled by elapsed time against a screen that depends on the host: whether a newer version is known, whether the folder is trusted, and how loaded the machine is. Nothing ever read which prompt the key would answer.

**What landed.** `data/engines/codex.json` drops `launch.preKeys` and declares `launch.guardedDialogs` (folder-trust, update) with evidence. `lib/launch-dialog-guard.js` reads a capture and says whether a declared prompt, a bare composer, or neither is the live screen: a prompt is live when it lies below the last bare composer row, because Codex keeps its opening composer above a dialog and an answered dialog above the composer that replaced it. `lib/sessions.js` asks it immediately before each launch-time send. A declared prompt refuses the prime paste and any `preKeys`; an unrecognised screen on a pane never observed ready, or an unreadable pane, refuses them too. The refused paste is recorded `skipped` in the rule-delivery ledger with the prompt and what the operator should do, and the readiness wait logs the prompt when it is first seen.

**An empty capture is an unread pane.** `tmux.capturePane` answers a failed `capture-pane` with no lines rather than throwing, so the refusal treats zero lines as unread. The first version caught only a thrown error, which that function does not raise once the session is known to exist, and a preKey would have gone through; the boundary review found it and the tests now stub what tmux really returns.

**A profile entry that cannot be read refuses every send.** The reader first dropped a malformed `guardedDialogs` entry with a warning, and its comment said that could never make a launch type more. It could: with the entry gone the prompt it named was invisible, and a preKey or a ready-pane paste went into it. The reader now counts what it dropped and the refusal fails closed on any. Found by the review of the merged head.

**Named for what it guards.** The declaration was first called `launch.startupPrompts`, in `lib/startup-prompts.js`. "Startup prompt" already names the text TangleClaw fires into a session (#1825), one letter away, so before release the key became `launch.guardedDialogs` and the module `lib/launch-dialog-guard.js` (Architect A158). Names only: no behaviour and no assertion changed.

**Deliberate behaviour change.** A Codex launch in an untrusted folder now stops at the trust prompt. No path accepts folder trust; the Operator has given no policy for it.

**A test expectation changed, on purpose.** `test/codex-launch-modes.test.js` asserted that the bundled Codex profile resolves to `['Enter', 'Enter']`. That was the behaviour being removed, so the assertion now uses a synthetic profile for the fallback rule it was really about, and a new test pins that bundled Codex sends no `preKeys` in any mode.

**Not covered.** Dismissing the update prompt (later, after matching tests). The opening screen, which this reader calls a composer; telling it apart is the wake gate's pane refusals in the next chunk. Codex versions other than 0.156.1: the prompt wording is assumed unchanged, from earlier captures, and was not re-measured. A real `launchSession` against a live Codex was not run; the refusals are tested through `_deferEngineInit` with stubbed tmux and through the reader on whole live captures. The log line for a prompt first seen mid-wait is exercised only through `_awaitPaneReady`'s observer hook.
## 2026-10-08 — #2165 follow-up: the hidden-state-word test checked nothing; fallback claims reworded

<!-- prawduct: type=bugfix | scope=2165-state-word-test-reach -->

A small test-and-docs follow-up to PR #2179, on the PM's dispatch, for three notes the Architect accepted as non-blocking at its exact-head review (A153).

**The test.** "never hides the state word by any style" matched only selectors containing `.car-state`. The stylesheet has no such rule, because the word needs none, so the assertion ran against an empty set and could not fail. What can hide the word is a rule on a box it sits in. The test now selects every rule whose selector names the release panel, the card, the row of cars, the car's disclosure, the pill or one of its states, leaves out rules on pseudo-elements (they style the disclosure's marker or its content, not the summary), requires that set to contain the boxes it claims to cover, and refuses `display:none`, `visibility`, `opacity`, a zero font size, any `overflow`, `clip` or `clip-path`, `text-indent`, a fixed or maximum width or height, absolute or fixed positioning, a transparent colour and `content-visibility`.

**Two things the Critic found in the first version of this fix.** The rule splitter read a whole `@media` block as one rule named by its prelude, so a rule hiding the word on a narrow screen would have been filtered out unseen; the stylesheet already has such a block. At-rule blocks are now opened up before the rules are read, and the helper refuses a stylesheet it could not fully open. And the companion test carried its own copy of the pattern, so it proved the copy; there is now one `HIDES` pattern and one `rulesReachingTheWord` helper, used by all three tests. The companion feeds the pattern every kind of declaration it names and a sample of the stylesheet's real ones; a third test shows a rule inside an at-rule block being seen and a pseudo-element rule being left out. Nine mutations of the stylesheet each turn a test red, three of them inside or beside an at-rule block.

**What it still does not cover.** The page's own stylesheet in `lib/plan-docs.js` is outside the checked set, and the refused declarations are a list, not a proof: `transform:scale(0)` or a zero `font` shorthand would pass.

**Root cause.** I wrote the test from the selector I had just added to the markup, not from the question it was meant to answer. A negative assertion over a filtered set needs the set shown to be non-empty.

**The fallback.** A test comment and a sentence in `FEATURES.md` stated that where a browser cannot style `::details-content` the detail is the full-line item itself. That is what the CSS is meant to do; nobody has run it in such a browser. Both now say so. Issue #2207's first step, which expected a closed car to omit its state, is updated for the visible state word.

No renderer or stylesheet change.

## 2026-10-07 — #2165: release panels, two more car states, a car-state legend and car details on served plan pages

<!-- prawduct: type=feature | scope=2165-release-panel -->

#2165, chunks C1 to C3, on the PM's dispatch, one lease per chunk with a PM-run `/clear` between them. The design follows Architect ruling A86 and its addendum.

**C1.** `parseTrainBlock` became `_parseJson` plus one `_validateTrain`, so a train object is checked by the same code wherever it appears. Car states `in-review` and `dropped` were appended to `CAR_STATES` rather than inserted, because an existing test pins the earlier enum text as a prefix of the refusal reason. A supplied state must agree with `closed`; counts use the effective state, and a dropped car is left out of both figures. Optional `owner`, drawn as a lane label.

**C2.** A `tc-release` block renders one planned release as a plain `<section>` holding the existing train cards. Each workstream passes `_validateTrain` and then the release-only rules: an explicit `kind` of `train` or `bucket`, no nested `version`, no repeated train identity, no two buckets with the same title. The header's figures are computed and cannot be supplied.

**C3.** One legend per page, in front of the first train card or release panel that renders, from the single map `CAR_STATE_MEANING`. A guard test fails when a state lacks legend words, table words or a style rule, and a contrast test holds every pill to 4.5:1 in both colour schemes.

**Decision: the page owns the legend's once-per-page state.** The plan had `renderPlanBody` create it at depth 0. That would have put the legend in front of a lone `tc-train` block's output, which an existing test anchors at `<details class="train-card">` and which ruling A86 item 6 keeps byte-compatible. `renderPlanPage` creates the page's shared state instead (`pageState(true)`, which records that the legend is still owed) and `renderPlanBody` draws no legend without it. Rejected: editing the anchored test. `server.js#servePlanPage` reaches the renderer only through `renderPlanPage`, so a reader always gets the legend.

**Buckets are rows of the panel.** Architect ruling A86 item 4 makes release-scoped Topic Buckets rows that count in the panel's total, because most of a release's cars live in them. ADR 0024 Amendment 1 (`docs/adr/0024-roadmap-release-grouping.md`) records this; Decision 4 as first written excluded buckets from the Release view. Making the panel the board's default layout is a separate step under that amendment's conditions, not something this work does.

**Legend wording ratified.** The Operator ratified the six meanings in `CAR_STATE_MEANING` as written (PM dispatch, 2026-10-07).

**Car detail, added on the Operator's request at ratification.** Each car shows its issue number and title, its state with the legend's meaning, an optional new per-car `reason`, and the train's `owner`. `reason` is accepted on a car in any state and skipped when blank. No per-car owner, no reason column in the issue table, no change to the queue card's pills.

**How it ended up, and why (Architect rulings A117, A121, A126, A144).** Four designs were pushed or built before this one; the published heads were `745409a5`, `4e4a0514`, `dd760c43` and `528ddb5d`.
- *Markup.* The pill's `title` and `aria-label` are gone and every car is a tab stop, so a stand-alone `tc-train` block with cars no longer renders to the same bytes. A117 waived byte-identical rendering for the pill and kept parsing compatible. The lighter keyboard route is #2185.
- *Description, then native semantics.* The overlay and hover designs hid the detail from assistive technology where it sat and tied it to its car with `aria-describedby` and a page-unique id, so a row read as car numbers and a car's detail was read on focus (A117). With the disclosure below, the Architect withdrew that (A145): `aria-hidden` would hide an opened detail from a screen reader, and `aria-describedby` would read it before it was opened. Cars now carry no `aria-` attribute, role or id, and the id counter is gone from `pageState`.
- *Cars outside the collapsible (A121).* With the cars inside `<summary>`, pressing one toggled the train, and CSS cannot stop that. A train card is now two rows: `div.train-cars`, always visible, then `details.train-detail` with the name, count and badges. This amends A117's "preserve the surrounding train markup" narrowly; counts, order and the body are unchanged. Every assertion naming the card's outer element was rewritten.
- *In the flow, not over the page (A126, option b).* WCAG 2.2 SC 1.4.13 requires hover or focus content to be dismissible without moving the pointer or focus, unless it obscures nothing. Dismissing means Escape, which needs a script, and the plan page's CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src https: data:`, pinned by `test/api-plan-docs.test.js`) allows none. That was returned to the PM as a conflict with three routes: a hash-pinned script, an in-flow detail, or a reserved strip. The Architect chose the in-flow detail and kept the script prohibition; a script may be considered later with #2185. The detail therefore takes a full line of the row under its car's line: it covers nothing and clips nothing.
- *Pressed, not hovered (A144, from the Operator's own check on a preview of `dd760c43`).* That head opened the detail on hover and on focus. The Operator found hover followed by a click to be double work, with the row moving twice, and asked for a click or tap to open it and the legend to carry the status meaning. Each car is now a native disclosure: `details.car-slot` with the pill as its `summary`, toggled by the browser on click, tap, Enter and Space. No rule for a car depends on `:hover` or `:focus`. Chosen over the ruling's minimal candidate (drop the hover rule, keep focus) because focus on tap of a non-button is not promised on phone browsers, a second press would not close it, and a tap inside the detail would. The disclosure has `display:contents` and its `::details-content` slot is the full-line flex item, with the detail itself as the fallback item where that pseudo-element is not supported. Cars are deliberately not grouped with `name`: closing the previous detail is what would move the car just pressed. I first kept `aria-describedby`, `aria-hidden` and the ids, reading A144's "accessible per-car description" as those attributes; the Architect corrected that in A145 and they were removed in a second local commit, conditional on VoiceOver confirming the native announcement on the served preview; that confirmation was never obtained (see the verification paragraph below). `tabindex` is gone because a summary is focusable by itself.
- *Driven, not only read.* For this design a script in the session's scratchpad drove real mouse, keyboard and touch input in headless Chrome over the DevTools pipe and measured every car's position: hovering opens and moves nothing; a click or tap opens only that car's detail and does not move it or any car before it; a second car opens without the first closing or the second jumping; pressing again restores the row exactly; Tab reaches every car once in order and then the train's name line; Enter opens and Space closes with focus kept; at a 390 px touch viewport nothing scrolls sideways and a 300 + 300 character detail is whole; Chrome's accessibility tree exposes a closed car as a disclosure named by its summary's text and marked collapsed, with its detail not exposed (the name was the number alone at `2d883076` and is the number and the state word, for example "#2104 open", since `0e26c3a0`); an open car as expanded, with its detail as readable content right after it and before the next car; and the train's own summary as its name, count and lane with no car in it. That is Chrome only. Safari, Firefox, a real phone and a screen reader are the Operator's check.
- *Found in a browser, not by tests.* An earlier overlay version with no `top` opened over its own car's line, because a `<span>`'s static position is taken as an inline box; only a headless render showed it. Style assertions cannot see geometry, so each structure change was rendered and looked at before its tests were written.

**Operator verification (`VRF-2165-C3`), 2026-10-07, on a private tailnet preview of the local commits.** Desktop click in light and dark, keyboard, and a real phone: PASSED by the Operator on `69cbabb1` ("i did checks 1 and 2 and they work great. love it. tried 3 on my phone its great."), carried to `2d883076` by the Architect because the stylesheet is byte-identical and the card markup differs only by the removed `aria-` attributes and ids. The screen-reader check: NOT VERIFIED. The Operator declined it as product owner ("We don't need a voiceover check. I'm not even interested in using that feature with the roadmap.") and no human tester exists. A145's condition for native disclosure semantics, that VoiceOver confirm them, is therefore UNMET, and this was released toward the push by the PM with that stated. The risk is `display:contents` on `<details>` in Safari and the `::details-content` layout on older browsers; it is filed as #2207. Chrome's accessibility tree supports the design and does not prove it.

**State on the closed car (Architect ruling A153, after the first published press-to-open head `64af5806`).** That head rendered a car as `#N` alone: with the pill's `title` and `aria-label` gone and nothing put in their place, a closed car's state was carried by colour alone, plus a strike-through for dropped. I named it in the PR body as a trade; the Architect ruled it a regression against #2165, which says state is never carried by colour alone, and held the merge. Two corrections were built in a detached scratch checkout, behind a switch that never entered the branch, and shown side by side: a visible state word on each car, or a visible mark per state with the word kept only for assistive technology. Measured for a 22-car train: 3 lines before, 5 with words and 3 with marks at a desktop width; 7, 12 and 8 at a phone width. The Operator chose the word ("i like variant A - what a brilliant idea."). Each summary is now `#N <span class="car-state">word</span>`, the word from `CAR_STATE_TEXT`, visible, and the summary's own text. A test holds all six states to a distinct visible word and forbids any style that hides it.

**Also in the state-word commit `0e26c3a0`, from the independent reviewer's notes.** The user guide's sentence about colour now says what a car shows at rest. The guide's list of the six legend meanings, a second copy outside `CAR_STATE_MEANING`, is held to the map word for word by a test. The `_car` comment says what the markup provides and that a screen reader's reading of it is unchecked, instead of stating an announcement as fact.

**Which of the Operator's checks reach the state-word commit.** The desktop click and keyboard passes were made on `69cbabb1`, before the state word; the Architect carries them to this design (A153 as amended), since the word changes a car's text and width and not how it is pressed. The real-phone check was made again on the state-word commit `0e26c3a0`, on the preview, and PASSED: the Operator's words were "looks fine on phone", with a screenshot showing every car with its number and state word and the long train wrapped cleanly with nothing cut off, and "yes, they open and close on click or tap by phone." Those two statements are all the Operator said about this version. That an opened detail is readable in full on the phone is CARRIED from their earlier phone check, not restated: the state word changes a car's summary text only, and the detail is unchanged. The screen-reader check stays NOT VERIFIED (#2207). Separately from the Operator, the 25 real-input checks in headless Chrome pass on the served preview page itself at the final local head, measuring positions to within one pixel of rounding: hover does nothing, a click or tap opens only that car's detail without moving it, Tab reaches every car once in order, Enter opens and Space closes, and nothing scrolls sideways at a 390 px touch viewport.

**One refusal reason corrected.** A release entry that left out `kind` and had no train identity (a bucket written without its kind) was refused with a reason about the missing train identity, because the shared train rules ran first. A missing kind is now refused before them, so the reason names the kind. A kind that is present but not one a release holds is refused where it was, with the reason it had.

**Not verified here.** The Shared-repo board generator does not emit `tc-release` yet, so the block has been exercised with fixtures only. Safari and Firefox on a desktop were not checked by anyone.

**Found while building.** `test/checkout-freshness.test.js` "two clones of one repository read the same observed upstream" compares two `describe()` calls whose wording carries a wall-clock age, so it fails when a second boundary falls between them. It failed once in a full run on a loaded host and passes in isolation. This branch does not touch it. Filed as #2175. A second full run, on the tree as it stood before the car info popover, passed that test and failed one other, `test/startup-control-codex.test.js` "an accepted turn whose end no notification reports is still settled from the record by the poll", the known load race in #2057, which also passes in isolation and which this branch does not touch. Each run passed every other test. No uncontended full run was possible on the host that day, so the local evidence is recorded as degraded and CI on the PR head is the full-suite evidence.

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
