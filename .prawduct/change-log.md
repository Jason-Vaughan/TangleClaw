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

## 2026-10-17 — #1280, #1903: a session's files: stamp no longer carries an earlier wrap commit's paths, and one shared lift helper replaces the private brace-matchers going forward

<!-- prawduct: type=bugfix | scope=w10-a1-wrap-commit-subtraction-and-lift-helper -->

v5.34.0 Wave 10 chunk W10-A1, chunk 1 of 1. Branch `fix/1280-1903-w10-a1` from `origin/main` `0eb92b05`. Closes #1280; refs #1903 (Chunk 01). Plan: `.tangleclaw/plans/w10-a1-wrap-commit-subtraction-and-lift-helper-1280-1903.md` (rev1 sha256 `8c9d6df9…7853`, approved by INT `bdd5fe33` and Architect A229); charter v2.32 (sha256 `57e66a84…d025`).

**#1280.** `continuity-write` records `files:` over the session range, which opens at the previous wrap commit's parent (#664), so it always held that wrap commit, and a wrap commits the whole tree. A session range with an earlier wrap commit in it is now walked commit by commit and every wrap commit is dropped except the one this wrap made (all of them when it made none). A path an earlier wrap commit and a real commit both changed stays. One delta still feeds the Map and the stamp. `_git-range.js` gains `WRAP_SUBJECT_RE`/`isWrapSubject` and `hasEarlierWrapCommitsAsync`; a parity test holds `changelog-coverage`'s copy of the rule to the same answers. Two choices the plan did not settle, both approved by Architect A231 at `00ba23e4`: only a session range subtracts, so the trunk fallback (published only when no wrap has ever stamped) keeps the branch's divergence as measured; and a refused walk logs the diff path's "session delta was refused" line, while a killed one keeps its own line. Follow-up #2465 moves `changelog-coverage` onto the shared rule.

**#1903 Chunk 01.** New `test/helpers/lift.js`: `liftDeclaration`, `liftBody`, `loadEsc`, `loadJsArg`. `test/lift-helper.test.js` pins the copies' exact behaviour, the string/comment brace limitation included, proves the loaders run the shipped `esc`/`jsArg` text from `landing.js` and `session.js`, and freezes the inventory of private copies (90 lifters, 3 named exceptions) as an exact multiset. No existing test file migrates here.

**Limits.** Wrap commits are matched by subject prefix: a hand commit starting `Session wrap` is subtracted too, as `changelog-coverage` already does. A refused probe keeps the plain diff, which over-reports by the earlier wrap commit as before; a killed one is named. `changelog-coverage.js` keeps its own copy of the rule until the follow-up issue lands. The inventory rule finds the `indexOf('{')` brace-matcher shape only.

**Tests.** `test/wrap-continuity-session-provenance.test.js` (real git): new subtraction, shared-path, walk-beside-a-trunk-sync cases; the four D5 assertions re-based. `test/wrap-step-continuity-write.test.js`: subject table, parity, probe refused/killed, walk subtraction, fallback untouched. Mutations: no subtraction, subtracting this wrap's own commit, diff-minus-paths, a re-implemented loader and a new private copy each went red.

**Review.** Cumulative Critic `rev-20261017T200335Z-b77aed4c`: 0 blocking.

**rev-20261017T200335Z-b77aed4c** — 2026-10-17T20:04:55Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | The declared suite runs once on the final tree in the Integrator's suite slot (charter v2.32 order, after the Architect's pre-suite read) and is recorded as test evidence before the ready report. The narrow ring on head 00ba23e4 (13 files: every test naming _git-range or continuity-write, the named out-of-lock wrap tests, and lift-helper) passed 786/0. |
| R-2 | note | accepted | By plan: Step C adds the entry after the Critic. It is prepended in the next commit, a records-only change to .prawduct/change-log.md. |

**2 findings** (1 warning, 1 note) — accepted: 2.

## 2026-10-17 — W9-REC: the v5.34.0 Wave 9 combined records

<!-- prawduct: type=chore | scope=w9-rec-records -->

v5.34.0 records chunk W9-REC (charter v2.31 §3). Branch `docs/w9-rec-records` from `origin/main` `54f2b06a`, after W9-B1 PR #2462 (`0a4dc303`, closes #2206) and W9-A1 PR #2463 (`54f2b06a`, closes #2042 and refs open #2059) merged. The Integrator authors this records-only PR under A172.1.

**What changed.** `CHANGELOG.md` `[Unreleased]` receives two Fixed entries for the bounded stored-blocker lookup retry and fail-visible change-log merges, plus one Internal entry for the A123 ADR slice. Each new entry stays under 400 UTF-8 bytes. `FEATURES.md` describes the retry, merge safety and ADR 0025 with stable file or symbol pointers. `prawduct-hook archive-change-log --apply` moves 10 older shipped entries verbatim into `.prawduct/change-log-archive/2026-10.md`; the five newest entries stay live.

**Limits.** #2059 remains open; A123's two Operator-reserved decisions are recorded, not decided here. GitHub's server-side treatment of the merge attribute and per-clone `.git/info/attributes` overrides are unverified. W8's Antigravity live check and 15 s sweep check remain owed after authorized deploy. This PR does not release, tag, bump a version or deploy.

## 2026-10-17 — #2042, #2059: the change log merges as text so conflicting edits stop corrupting it, and A123 is recorded as ADR 0025

<!-- prawduct: type=bugfix | scope=w9-a1-change-log-merge-and-a123-adr -->

v5.34.0 Wave 9 chunk W9-A1, chunk 1 of 1. Branch `fix/2042-2059-w9-a1` from `origin/main` `d06cd1e1`. Closes #2042; refs #2059. Plan: `.tangleclaw/plans/w9-a1-change-log-merge-and-a123-adr-2042-2059.md` (rev1-r2, sha256 `53a86ae8…4b26`, approved by INT and Architect A219); charter v2.31 (sha256 `9918cf38…532f`).

**#2042.** `.gitattributes` marked this file `merge=union`. Union never reports a conflict: two edits to one entry survived as two copies of it, one a heading with no body, and the merge exited 0. The file now merges as `merge=text`, with a comment saying why union must not return. The header above says a conflict at the top of the file is expected and how to resolve it.

**#2059 (A123 slice).** `docs/adr/0025-codex-cold-start-wake-and-pane-refusal.md` records Architect ruling A123 (2026-10-07): D1–D5, the #2177 containment, the D3/D4 merge gate, the original order, the two Operator-reserved decisions and the A175/A168 amendments, verbatim from the ruling page, plus file-level code pointers read on `main`. It cites no private path or tailnet URL. The rest of #2059 stays open.

**Limits.** Every branch sync that brings in new entries now conflicts at the top of this file, on purpose. Whether GitHub's server-side merge honours the attribute was not checked. A clone's own `.git/info/attributes` can still set union. Prawduct's advisory recommending union is parked for the Operator, not dismissed.

**Tests.** New `test/change-log-merge.test.js`: real merges in sandboxed temp repos. A union control reproduces the corruption; the shipped attribute conflicts on the same edit and on two independent prepends, beside the header guidance, which resolves them; edits far apart merge cleanly to a fixed result; the repo's attribute reads `text`. Tests 2, 3 and 5 were red on union, and three mutations each turned the intended test red.

**Review.** Cumulative Critic `rev-20261017T174307Z-4ee22d79`: 0 blocking.

**rev-20261017T174307Z-4ee22d79** — 2026-10-17T17:44:11Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | The declared suite runs once on the final tree in the Integrator's suite slot (charter v2.31 order, after the Architect's pre-suite read) and is recorded as test evidence before the ready report. The narrow ring on this head (the new file, temp-repo.test.js and every test naming .gitattributes, change-log.md or docs/adr) passed 854/0. |
| R-2 | warning | fixed-unreviewed | fixed in `.prawduct/change-log.md` |
| R-3 | warning | accepted | Parked by INT ruling D3 (b337caaf): the advisory's disposition (dismiss per clone, or an upstream report via /prawduct:report-bug, which publishes outbound text and needs the Operator's approval of the bytes) is a separate PM/Operator decision. W9-A1 neither dismisses it nor reports it. The .gitattributes comment is the in-repo guard. |
| R-4 | note | accepted | Deliberate: the approved plan requires each amendment line to say it does not relax the separate launch/readiness proof, and the section lead states it once for both. The line break is source wrapping inside a list item and renders as one paragraph. |

**4 findings** (3 warning, 1 note) — accepted: 3, fixed-unreviewed: 1.

## 2026-10-17 — #2206: a locked store gets one bounded retry and one diagnostic at the stored launch-blocker lookup, and a failed lookup is still never "no blocker"

<!-- prawduct: type=bugfix | scope=w9b1-stored-blocker-lookup-retry -->

v5.34.0 Wave 9 chunk W9-B1, one chunk. Branch `fix/w9b1-stored-blocker-lookup-retry` from `origin/main` `d06cd1e1`. Closes #2206. Plan: `.tangleclaw/plans/build-plan-w9b1-stored-blocker-lookup-retry.md` (rev 3, sha256 `b723c01e…fc9`, accepted by INT and Architect A220); charter v2.31 (sha256 `9918cf38…b532f`). Lock: `lib/tmux.js`, `lib/sessions.js`, `test/startup-dialog.test.js`, `test/sessions.test.js` (headroom, not touched), this file.

**The change.** Both send gates (`_startupDialogOn` in `lib/tmux.js`, and `_startupDialogAtSend`'s no-row path in `lib/sessions.js`) read the pane's stored launch blocker through one new exported `tmux.readStoredLaunchBlocker(tmuxName)`. A lock held by another connection (`SQLITE_BUSY`: `errcode` 5, or SQLite's busy message) is retried once after `STORED_BLOCKER_RETRY_WAIT_MS` (50 ms, a synchronous `Atomics.wait`, as the workload append's retry). No other failure is retried. A throw that remains is still carried as unknown, never as "no blocker", so a send goes through only on a positive prompt reading (A146). The per-send `warn` is replaced by a condition log keyed `stored-launch-blocker-unreadable:<class>`, with the class from a fixed list (`SQLITE_BUSY`, `SQLITE_IOERR`, `SQLITE_CORRUPT`, `SQLITE_FULL`, `SQLITE_ERROR`, `unknown`; extended codes map to their primary code; a thrown `code` is never a class): one `warn` per class per incident, `debug` while it persists, and a lookup that answers resolves every class. `_startupDialogOn` keeps its no-store-open guard; the launch path still has none, so a closed store is unknown there, not retried.

**Decisions (INT, as recommended).** D1 one retry after 50 ms; D2 no connection-wide `busy_timeout` (it would touch every store call); D3 the launch path's `store.sessions.get(sessionId)` read is not retried (a throw there already falls to the retried lookup).

**Residual.** A lock held past the retry still refuses sends to panes not at the prompt, by A146's rule; the diagnostic now names it once. While another connection holds the lock, each text send waits at most 50 ms more.

**Tests.** New cases only in `test/startup-dialog.test.js`; no existing assertion changed. T1 busy then answer (both callers), T2 busy twice (prompt sends; empty, undecided and unreadable panes, unnamed and non-declaring engines refuse; a dialog keeps its name), T3 a disk error and an uninitialised store are not retried, T4 a real `BEGIN EXCLUSIVE` on the test store's file (two lookups, refused, one `SQLITE_BUSY` warn; resolved after `ROLLBACK`), T5 one warn per class per incident and a fixed class list, T6 the wait is the constant and once per lookup, T7 the launch path's answers, T8 the launch path with no store open. The existing always-busy stubs now take one 50 ms wait longer each. The narrow run covered every test file that loads or reads `lib/tmux.js` or `lib/sessions.js` (108 files): green.

**Review.** Cumulative Critic `rev-20261017T174340Z-ece49f19` on `746ea62e`: 0 findings, 2 observations accepted.

**rev-20261017T174340Z-ece49f19** — 2026-10-17T17:44:14Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | accepted | The full suite runs once on the frozen head in INT's suite slot (charter 1.5, plan freeze step 3) and is recorded as test evidence before the ready report; the narrow run on 746ea62e (108 files that load or read lib/tmux.js or lib/sessions.js) is green, rc 0. |
| O-2 | accepted | Prepended at freeze step 2 in the commit after this review, carrying this review's id. |

**No findings** — a clean pass.
**2 observations demoted** — 2 answered. An observation gates nothing; answering one is optional.

## 2026-10-17 — W8-REC: the v5.34.0 Wave 8 combined records

<!-- prawduct: type=chore | scope=w8-rec-records -->

v5.34.0 records chunk W8-REC (charter v2.30 §3). Branch `docs/w8-rec-records` from `origin/main` `afbe5895`, after W8-A1 PR #2459 (`4051fc6d`) and W8-B1 PR #2460 (`afbe5895`) merged. The Integrator authors this records-only PR under A172.1.

**What changed.** `CHANGELOG.md` `[Unreleased]` receives two source-checked Fixed entries for #2452/#2453 and #2450/#2451, each under 400 UTF-8 bytes. `FEATURES.md` describes the cross-engine below-composer refusal, boot-watch clear failure handling, and the 15 s stored-blocker sweep. The archive dry-run moves no entries, so `.prawduct/change-log-archive/2026-10.md` stays unchanged.

**Limits.** A's Antigravity live check and B's 15 s sweep live check remain owed after an authorized deploy. The Claude dialog frame is constructed, not a live capture. A crash before the sweep's next tick may retain the old blocker cause. This PR does not release, tag, bump a version, or deploy.

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
