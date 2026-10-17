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

## 2026-10-17 — #2204, #2194, #2196: a stored launch blocker is written safely, read without sleeping, and kept current on the card

<!-- prawduct: type=bugfix | scope=w7b1-launch-blocker-status-reconcile -->

v5.34.0 Wave 7 chunk W7-B1, chunk 1 of 1. Branch `fix/w7b1-launch-blocker-status-reconcile` from `origin/main` `474a6824`. Closes #2204, #2194 and #2196. Plan: `.tangleclaw/plans/build-plan-w7b1-launch-blocker-status-reconcile.md` (rev 2, sha256 `944e87f9…ffac`, accepted by INT); charter v2.27 (sha256 `4209d42e…6f29`, Architect A196). #2195 stays parked (`2195WAIT`). The boot watch's own writes (#2450) and the stale record when nothing reads it (#2451) are follow-ups, not in this chunk.

**#2204.** `_reconcileLaunchBlocker` called `setLaunchBlocker` and `clearLaunchBlocker` with no catch. It runs inside a launch's pre-key and prime timers, so a store write that threw escaped the timer: the send was neither made nor recorded as withheld. Each write now has its own catch and logs a `warn` naming the session, the write (`set`/`clear`) and the error. The pane read decides the answer: a failed set leaves the stored value, a failed clear still answers `null` because the pane showed the prompt, and the row stays as it was until the next reader writes it. The prime timer's existing withhold path then writes its `prime-paste` `skipped` row with the dialog's reason.

**#2194.** `check` re-read a half-drawn dialog frame after `execSync('sleep 0.25')`, which blocked the event loop on every status poll of such a frame, though a status read types nothing. `check`, `checkEngine` and `look` take `settle` (default on, so every sender keeps its re-read). A status read passes `settle: false`, is answered from the first frame, and a half-drawn frame is still `suspect`, which is never stored.

**#2196.** The project card served `row.launchBlocker` as stored, so a dialog answered in the pane kept the card saying the launch was waiting. A new `sessions.liveLaunchBlocker(active, project)` is the one statement of a reader's view: no pane read when no blocker is stored, else the reconcile with `settle: false`. `getSessionStatus` and `enrichProject` both use it, the card only on a pane tmux confirmed. `_liveSession` keeps its two-argument contract and serves the stored row; `enrichProject` then sets `session.launchBlocker` from `liveLaunchBlocker` when tmux confirmed the pane. This departs from the plan's third-argument design (Architect A202), so that the existing source guard on the literal `_liveSession(activeSession, wrapping)` call in `test/wrap-indicator-card.test.js` still holds. Cost: one synchronous pane capture (and a cursor read on some frames) per session with a stored blocker, per project-list poll, only after tmux confirms the pane; a session with no blocker costs nothing. The badge renderer is unchanged: it already hides on `null`.

**Tests.** New cases only; no existing assertion changed. The session-level cases are in `test/startup-dialog.test.js`, whose harness already holds the dialog frames and the launch timers (INT told before the suite), so `test/sessions.test.js` is unchanged. `check` with `settle: false` reads once and does not sleep; `look`/`checkEngine` pass the option through. A status read on a half-drawn frame does not sleep, while an injection and a launch send on the same frame each re-read once. A failed set or clear does not throw, logs, and leaves the answer to the pane, also through the status read. A dialog the store cannot record at the paste still withholds it and writes the `skipped` row. `liveLaunchBlocker` reads no pane with nothing stored, clears an answered dialog, and keeps one still up. `test/card-session-contract.test.js`: the card serves `null` for an answered dialog and clears the row; a pane tmux did not confirm is not read. `test/api-sessions.test.js`: the status route serves a stored blocker on a half-drawn frame without sleeping. Each new card and API case was run against the unchanged `lib/` and failed. Narrow runs on the final head: the changed test files, `test/wrap-indicator-card.test.js`, every other suite file that reads `lib/projects.js`, `lib/sessions.js` or `lib/startup-dialog.js` as source, and the files that read a launch blocker or the card (`projects`, `engine-error-surface`, `session-rule-delivery`, `stranded-wraps-ui`, `engine-error-ui`, `sessions`), each exiting 0.

**Docs.** `docs/engine-guide.md` no longer says the project list serves the stored record without reading the pane: it now checks a stored blocker against the pane whenever tmux confirmed it (lock widened to this file by charter v2.28, Architect A206).

**First head, held.** On the first head, `7b69b093`, exact-head CI failed on that guard (run 39034005054): the first version passed the checked blocker as a third argument to `_liveSession`, which broke the literal. The host full suite on that head recorded 12616 passed / 0 failed while `node --test` exited 1, and its output was not kept (#2456; a strong inference, not proven, is that it was the same test, with the recorder's JUnit parse missing a nested failure). The head was held (A201 Option A), `origin/main` `81532b76` was merged in, and the fix approved by A202 was applied.

**Review (first head).** Cumulative Critic `rev-20261017T122449Z-be7bf447`: 0 blocking; 2 findings (1 warning, 1 note), both accepted. The warning (no full-suite run for this head yet) is answered by the full suite on the frozen head in the Integrator's slot. The note (no backlog item resolved) is answered by the PR's `Closes` lines.

## 2026-10-17 — #2358 + #2447: a stranded nudge in an Antigravity composer is recognised; the sibling tmux tests wait for bash

<!-- prawduct: type=fix | scope=w7-a1-antigravity-wake-at-rest -->

v5.34.0 chunk W7-A1 (charter v2.27, Architect A198; plan rev 2 `dc9466b1` approved by INT and the Architect). Branch `fix/2358-2447-w7-a1` from `origin/main` `474a6824`.

**#2358 (a).** Antigravity hides its `? for shortcuts` hint while its composer holds text. A switchboard nudge that missed its Enter therefore removed the marker the wake gate required, and every later wake refused it as `not-at-rest` until it escalated. This was captured live at 167x27; one Enter submitted the nudge. `_assessPane` now excuses the missing marker only when all of these hold:

- the composer holds exactly the monitor's own nudge, seen whole between its borders;
- no glyph-led row is drawn below the composer;
- the hint slot at the left of the status row is empty (`_hintSlotEmpty`).

The last two conditions were not in the plan. The marker's absence is also what refused a dialog. agy draws no bare prompt row while its composer holds text, so `_glyphRowBelowPrompt` had nothing to anchor on, and a selector below the nudge read `at-prompt`. INT accepted the below-composer condition as a routed safety choice. The cumulative Critic then showed that the recorded dialog analog (`AG_DIALOG_PANE`), drawn above the composer, also got through. Both measured own-nudge captures leave the hint slot empty, and that dialog fills it with its key help, so any text in the slot now refuses. The busy marker and an agent fleet are never excused.

**#2358 (b).** A wrap that starts a continuation row with `>` made `locateComposer` take that row as the composer's first, so the gate and the prompt clear's residue check both missed the nudge. With a box in view, meaning a border above the cursor and one below it, the first row is now the glyph-led row directly under its upper border. The lower border is required so that a rule row in Codex's transcript cannot make the message under it the composer's head. With no box in view, the nearest glyph-led row decides, as before.

**#2447.** The sibling `sendKeys`/`sendRawKey` tests typed into bash before its prompt was drawn. On a loaded host they scored tty echo rather than what ran. Each test starts its own session and calls one `awaitBashPrompt` helper that waits for the prompt. The helper does not start the session itself, so the name passed to tmux stays traceable by the #1983 session-name guard. The clearPrompt-false, enter:false and raw-Enter tests assert on output lines and fail when mutated; four more tests gain only the wait. The `paste-buffer -p (#75)` test that the plan listed reads the source and starts no bash, so it is unchanged.

**Tests flipped, not weakened.** Two pins that recorded the known-bug verdicts now record the fixed ones, as the issue's Expected asks: the measured M1 capture's `(b) CHARACTERIZATION` (`not-at-rest` → `at-prompt`) and the `>`-wrap case (`no-prompt` → `at-prompt`). The M1 "diagnostic only" test now asserts that the channel's idle answer makes no difference.

**Not covered.** The live check is owed after deploy: the first `pane-not-at-rest` episode on an Antigravity pane should end with the nudge cleared and replaced. The 167x27 fixture's cursor position is an assumption, because the capture did not record it. A real agy dialog has never been captured: one drawn above the composer that left the hint slot empty would still pass the excuse while our nudge sat below it. Claude Code has the same selector-below-own-nudge shape when no stale bare row is in the read; that predates this change and is filed separately.

**Review.** Inner verify-resolutions `rev-20261017T123118Z-dcd953d7`: 0 findings; its 3 observations were accepted (D3 kept those assertions; the out-of-scope full-bash tests; the suite runs in the slot). That mode was inferred from the old W6-A2 findings, so cumulative `rev-20261017T123313Z-0d5609a9` was run as the plan's boundary review. It found 1 blocking issue (the dialog above the composer) and 1 note (Codex rule row); both are fixed here, with tests shown red before. The stale-evidence warning was accepted: the full suite runs in the Integrator's slot. The change-log note is fixed by this entry. On `352fd461`, both the first local full suite and CI run `39033831768` were red with the same single in-diff failure: the #1983 guard refused a `startBash(session)` helper that started sessions under a parameter name. The helper was split, and the narrow ring now includes the source-scanning guards.

## 2026-10-17 — W6-REC: the v5.34.0 Wave 6 combined records

<!-- prawduct: type=chore | scope=w6-rec-records -->

v5.34.0 records chunk W6-REC (charter v2.26 §3). Branch `docs/w6-rec-records` from `origin/main` `508074e9`, after W6-B1 PRs #2444 and #2446 and W6-A2 PR #2448 merged. The Integrator authors this records-only PR under the charter's narrow exception to the Builder records rule.

**What changed.** `CHANGELOG.md` `[Unreleased]` receives the three reviewed PR fragments: #2201 under Fixed and #2202/#2203 and #2152/#831 under Internal. Each fragment stays under 400 UTF-8 bytes; no existing entry changes. All three PRs say Features: None, and no new file needs a `FEATURES.md` index entry, so that file stays unchanged. `prawduct-hook archive-change-log --apply` moves 27 older shipped entries verbatim from this live log to `.prawduct/change-log-archive/2026-10.md`, leaving the five preexisting newest entries live below this new entry.

**Not included.** #2447 remains queued for Wave 7 by the PM, not this records PR. No tag, release, version bump or deploy.

## 2026-10-17 — #2152 + #831: the draft-text tmux test waits for bash, and the last test files that made repos on their own

<!-- prawduct: type=fix | scope=w6-a2-tmux-prompt-and-temp-repo -->

v5.34.0 chunk W6-A2 (charter v2.26, Architect A192; plan rev 3 approved by INT). Branch `fix/2152-831-w6-a2` from `origin/main` `98774fb0`. It carries W6-A1's five reviewed #831 commits as cherry-picks (W6-A1 stopped on the #2152 flake; PR #2443 closed as superseded) and adds the #2152 fix.

**#2152.** The test "does not submit unsent draft text sitting at the prompt (#812)" typed its draft 0.3 s after starting bash. On a loaded host bash had not drawn its prompt yet, so the tty echoed `echo DRAFTRAN` above the banner and `!content.includes('DRAFTRAN')` failed although nothing ran. It now waits, bounded at 10 s and failing with the last pane lines, for bash's prompt, then for the draft on the prompt line, then for the injected command's output and a fresh prompt. The pane-text check is replaced by line checks on what executed: some line is exactly `INJECTEDOK` and no line starts with `DRAFTRAN`. With `clearPrompt: false` (the #812 defect) the test goes red on `DRAFTRANecho INJECTEDOK`.

**#831.** 38 `git init`/`git clone` calls in 19 test files went through a local `git(cwd, ...args)`, `git(cwd, args)` or `run(args)` helper, so each one copied the machine's global `init.templateDir`, which a running TangleClaw rewrites under the suite. The family guard in `test/temp-repo.test.js` could not see those shapes.

**What changed.** The guard gains a pass keyed on a git wrapper's definition, matched over the file's text so a `return` on the line after the signature counts. It knows which parameter carries the argv, even when the argv array spreads several values (`['-C', dir, ...extra, ...args]`), so `git(dir, 'init')`, `git(dir, ['clone', …])` and `run(['init', …])` are caught and a non-git helper such as `mk(dir, 'clone')` or `npm(dir, 'init')` is not. It replaces the earlier rest-parameter-only definition pattern, so wrappers are recognised in one place. New positive and negative scanner tests cover it. With only the guard applied it failed on exactly those 38 calls. All 38 now call `initRepo`/`cloneRepo` with their own arguments, cwd and env. Five helpers built their env inline; it is hoisted into a `gitEnv()` the helper shares. No assertion changed. The `_temp-repo.js` header and the SHAPES comment now say what the guard catches and what it still cannot see.

**Not covered.** The guard still cannot see a subcommand held in a variable, a wrapper whose body does work before `return exec*('git', …)`, a wrapper imported from another module, an argv the wrapper spreads from an array it was given, a leading argument with nested calls, or a call split across lines. None of these is in `test/` today; the list lives beside the guard's SHAPES.

**Review.** Cumulative Critic `rev-20261017T104048Z-7d244602`: 0 blocking; 2 warnings and 3 notes, all accepted. The warnings (the #2152 race in the other `sendKeys - behavioral` tests) are outside the chartered scope and filed as #2447. The `_temp-repo.js` header note is left so the carried content stays identical to `be288eab`.

## 2026-10-17 — #2201: a damaged launch blocker is logged once instead of dropped silently

<!-- prawduct: type=bugfix | scope=w6b1-dialog-classifier-and-launch-blocker -->

v5.34.0 Wave 6 chunk W6-B1 02 of 2. Branch `fix/w6b1-02-launch-blocker-warn` from `6216a7e5`. Closes #2201. Plan: `.tangleclaw/plans/build-plan-w6b1-dialog-classifier-and-launch-blocker.md` (approved rev 2a, sha256 `f93d2dd8…2376`); charter v2.24 (sha256 `08269a39…c875f`, Architect A184). #2195 stays parked (`2195WAIT`): `setLaunchBlocker` and its docstring are unchanged.

**Why.** `_launchBlockerFromRow` returned `null` without a word for a `sessions.launch_blocker` value that did not parse or named no `code`, so a damaged row read as "nothing is blocking this launch" with no trace of why. It runs on every session read, so an unkeyed warning would repeat on every poll.

**What.** A present but unreadable value now logs one `warn` per (session id, raw value), naming the session id, the reason (`not JSON` / `no code`) and the value's length, never the value itself, and still returns `null`. The memory of what was warned about is a Set keyed by session id and a SHA-256 of the value, capped at `LAUNCH_BLOCKER_WARN_CAP` (1000) and cleared when full, so a long-running server cannot grow it without bound; `close()` clears it too, since another database opened in the same process reuses session ids. The cap is exported for its test as `_LAUNCH_BLOCKER_WARN_CAP`.

**Tests.** `test/store.test.js`, a new `describe` that captures the logger (`setConsoleStream`, `setLevel('warn')`, restored after): missing → `null` with no line; valid → parsed with no line; not JSON → one line naming session, reason and length but not the value, none on a re-read; parsed with no code → one line; a new damaged value on the same session → one more; the same value on another session warns for it; after `close()` and a reopen the same session id and value warn again; at the cap a remembered value stays quiet, and once cleared it warns again. The five new warning cases fail on the unchanged lib. No existing assertion changed. Narrow run: every test file that reads a launch blocker (six files), green, with no new log line seen by any of them.

## 2026-10-17 — #2202, #2203: the startup-dialog classifier reads a pane once; its non-breaking space is spelled as an escape

<!-- prawduct: type=bugfix | scope=w6b1-dialog-classifier-and-launch-blocker -->

v5.34.0 Wave 6 chunk W6-B1 01 of 2. Branch `fix/w6b1-01-dialog-classifier` from `896f6f72`. Closes #2202 and #2203. Plan: `.tangleclaw/plans/build-plan-w6b1-dialog-classifier-and-launch-blocker.md` (approved rev 2a, sha256 `f93d2dd8…2376`); charter v2.24 (sha256 `08269a39…c875f`, Architect A184). Chunk 02 (#2201) is a later session; #2195 is parked (`2195WAIT`).

**Why.** `detect`, `assessBoot` and `classify` in `lib/startup-dialog.js` decide whether a send's Enter could land in an engine's startup dialog. Each re-derived the same reading of a frame (plain text, prompt row, last marker row), `assessBoot` and `classify` did it twice per call by calling `detect` first, and a fourth scan found a partial marker's owner (#2202). Three copies of one reading can drift apart. Separately, `_plain`'s blank-collapsing class held a literal U+00A0, which looks like a space; an editor that normalised it would silently stop NBSP-padded marker words from matching (#2203).

**What.** One internal `_read(lines, dialogs, wake, cursor)` returns `{text, rows, prompt, lastMarker, dialog, owner}`; the three public functions are projections of it and keep their signatures, return shapes and the deliberate boot-vs-answer difference. Every dialog's last marker row comes from one pass up the rows (`_markerRows`, replacing `_lastMarkerRow`), so each check makes one marker scan however many dialogs are declared, keeping each dialog's own last-marker rule and the declaration order. `_read` treats a missing dialog list as empty, so `assessBoot`/`classify` no longer throw a TypeError on one (INT ruling; every caller passes `declared()`'s array); tests pin it for null and undefined. `_read` is not exported and there is no spy test: the helpers are called only inside `_read` (INT ruling). `_plain` spells the character as an escape, as `_norm` already did. The docstring half of #2202 was already fixed on main by `cdba432b`; the charter's `_assessEnginePane` is `assessBoot`.

**Evidence.** A behaviour pin (every named pane fixture in the test file, with and without its cursor and the prompt signature, against Claude's dialogs and a list adding a second dialog sharing a marker) was committed green on the unchanged lib (`6cd4b1fb`) and is unchanged and green after the refactor. A fixture pads the trust dialog's marker words with U+00A0; a source guard fails on a literal U+00A0 in `lib/startup-dialog.js` (checked by reintroducing it: 1 fail; restored). No existing assertion changed.

## 2026-10-17 — W5-REC: the v5.34.0 Wave 3, 4 and 5 records

<!-- prawduct: type=chore | scope=w5-rec-records -->

v5.34.0 records chunk W5-REC (charter v2.21 §3; Architect A180 accepted plan rev 1). Branch `docs/w5-rec-records` from `origin/main` `9273fe67`.

**Why.** Lane Builders do not edit `CHANGELOG.md` or `FEATURES.md`; each of the nine PRs merged since the Wave 1+2 records PR #2429 left its entries in its description. This brings both files level with `main`.

**What changed.** `CHANGELOG.md` `[Unreleased]`: eleven entries from #2430, #2431, #2432, #2434, #2435, #2436, #2437, #2440 and #2441, pasted as each merged description has them, in the subsection it names (#2441 named none; it is a new screen element, so Added). `FEATURES.md`: the five feature entries those descriptions give (#2437's with a bold label added, #2434's label set in bold), the "Launch isolation inventory" citations moved to `lib/recorded-launch-command.js` where #2375 put the definitions, and a Tests-map line for each of the seven test files the PRs added, so no wrap stubs them. This file: a blank line restored before five headings that had none (the one #2436 noted and four more like it); no entry's text changed.

**Not covered.** #2435's owed learning needs `.claude/rules/learnings/`, outside this chunk's lock. No version bump, tag, release or deploy.

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
