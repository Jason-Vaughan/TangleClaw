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

## 2026-09-28 — The Discord helper's command, launchd job and guide (#1799, C2 chunk B)

<!-- prawduct: type=feature | scope=discord-helper-1799 -->

C2 chunk B, completing C2 (chunk C was folded into A, because C1.5 carries notifications).

**Problem.** Chunk A's modules had no caller: nothing could configure, run, check or install the helper.

**The change.**
- `bin/tc-discord-helper` is a thin launcher over `lib/discord-helper/cli.js`, whose dependencies are injected. Commands:
  - `configure`: the non-secret config at `~/.tangleclaw/discord-helper.json`.
  - `set-secret`: reads the token with echo off on a terminal, stores it through `security -i`, and reads it back as proof.
  - `verify`: proves both tokens and posts one test notification.
  - `run`: pid lock (two helpers would double-post), status snapshot, stop on SIGTERM/SIGINT. It exits 78 by closed code for no config, an unreadable record or a missing secret, before contacting anyone.
  - `status`: reads the record with `peekState`, never writing it, so it cannot write back a copy older than the live helper's.
  - `settle`: refused while the helper runs.
  - `install-launchd` / `uninstall-launchd`.
- `deploy/com.tangleclaw.discord-helper.plist` holds paths and a label only, with ThrottleInterval 30. A token Discord refuses stops the Gateway without ending the process, so KeepAlive restarts cannot spend the identify budget.
- `docs/discord-helper.md` is the operator guide: the Developer Portal intent, the ids, secrets, verify, launchd, held replies, refusals and log codes. The docs that point to it were updated: operator-channel.md, FEATURES.md, PROJECT-MAP.md and CHANGELOG. VRF-003 is queued for the live round trip on the operator's Mac.

**Review fixes riding this commit.**
- From verify `rev-20260928T023958Z-f385749f`: O-1, pruning now happens only on an EMPTY listing, which is complete whatever the server's page size; O-3, `StateError` is consumed at start-up.
- From cumulative `rev-20260928T025418Z-c82fad91` (0 blocking, 3 warnings, 11 notes; it covered HEAD 7f39395f, not this tree):
  - R-1/R-5: inbound hand-overs are serialized through one queue, so a retried message is never overtaken.
  - R-4: fixed by the empty-listing rule.
  - R-2: `outbound-queue-held` is logged when every listed reply is held.
  - R-3: the secret is read back after storing.
  - R-6: refusal keys now match the server's codes (`MESSAGE_TOO_LONG`, `EMPTY_MESSAGE`, `BAD_MESSAGE`).
  - R-7: a notification's title no longer repeats "TangleClaw:".
  - R-8: the `listOutbound` JSDoc is corrected.
  - R-10: a 429 wait is logged as `discord-rate-limited`.
  - R-9/R-11: the docs and the caller are added here.
  - R-12 (operator-channel row retention, C1's code) is accepted and routed to the PM. R-13 and R-14 are informational.

**Follow-up from verify `rev-20260928T030041Z-3a1dca3e`** (0 findings). O-1 (a restated suite count) is accepted. O-2: the one-helper lock is now exclusive. Following verify `rev-20260928T031015Z-07457490`, the pid is written to a private file and hard-linked into place, so the lock never exists empty, and an unreadable lock is treated as held. Two `run`s started at once cannot both post. One race remains, stated in `acquireLock`: two starts that find the same stale lock (after a crash) at the same moment. launchd runs one job per label, so it needs two starts by hand. O-3: `status` checks a snapshot's shape before reading it, and the launcher reports an unexpected failure by its type alone. Tests cover each: two simultaneous helpers, and a `{}` snapshot. The lock mutant (`w` for `wx`) turns the file red.

**History rewrite and the review after it.** GitHub push protection refused the first push because the fake test bot token had the shape of a real Discord token. The unpushed branch was rewritten with filter-branch, changing only that constant (now plainly fake) in two test files.

The fresh cumulative `rev-20260928T032547Z-04e82142` then found 1 blocking issue, fixed here: R-1. A definite failure after a doubtful attempt cleared the doubt, so a later retry could post twice. Now only the attempt that opened the doubt may clear it; a test covers timeout, then network down, then recovery.

The rest of that review:
- R-3: INVALID_SESSION now uses the shared backoff, with a 1-5 s floor, rather than retrying every few seconds.
- R-2 and R-4: `run` takes the lock before opening the record, and `settle` takes and releases the same lock.
- R-6 (the ✅ does not confirm delivery): documented, accepted, and routed to the PM as a C1 follow-up.
- R-5, R-7, R-8, R-9: accepted.
- Five mutants, one per fix, each fail a test cleanly.

**Evidence.** `test/discord-helper-cli.test.js` covers every command, with a sweep that finds neither secret in any file the commands wrote or anything they printed. The three helper test files are green. The real binary's `usage` and `status` were run on this host: `status` reads the Keychain and writes nothing. Four new guard mutations (queue, queue tail, held log, read-back) each turned a test red. The full suite was recorded green at the chunk B boundary before these review fixes (7816 passed, 0 failed, 1 skipped); it is re-run on the final tree before the PR (recorded on that tree; see test-status).

## 2026-09-28 — The Discord helper's relay modules (#1799, C2 chunk A)

<!-- prawduct: type=feature | scope=discord-helper-1799 -->

C2 chunk A, resumed on the PM's go (Medusa df246926) after C1.5. The parked WIP (log, secrets, state, C1 client, Discord REST) was rebased onto C1.5 @198acf21, and the rest was built. Plan: `.tangleclaw/plans/1799-discord-helper.md` (local, not tracked); its "Decisions made while building chunk A" section records every departure from the design.

**Problem.** C1 and C1.5 give the operator a chat-agnostic channel with no chat client. Nothing yet connects Discord to it.

**The change.** Modules under `lib/discord-helper/`, with no new dependency and not yet runnable (the CLI and launchd job are chunk B):
- `gateway.js`: HELLO/heartbeat/IDENTIFY with GUILDS, GUILD_MESSAGES and MESSAGE_CONTENT only. A zombie connection is detected by a missing ACK and closed with 4000 so the session survives. It resumes on `resume_gateway_url`, identifies afresh after 4007/4009 or a non-resumable INVALID_SESSION, and stops for good on 4004/4010-4014. Reconnect uses capped jittered backoff. The Gateway URL is fetched from `GET /gateway/bot` and cached.
- `inbound.js`: an id-only allowlist filter that runs before `content` is read (a test tripwires the getter). A message is relayed verbatim under its Discord id and gets a ✅ reaction on 202/200. A refusal is answered in fixed words, with a nonce derived from the message id so it is posted once. An unreachable TangleClaw is retried three times, then the operator is told.
- `outbound.js`: bounded poll with capped backoff, and single-flight. Each item is acked only with Discord's returned id. The durable record and the nonce make a crash mid-post safe inside a 2-minute window. Past it the item is `uncertain`; a Discord 400 makes it `rejected`. Both are held for the operator and never retried, so one bad item cannot block the queue. A long item is split into up to 5 parts, each nonce'd and recorded as it lands. Notifications are titled by `type`.
- `secrets.js`: stores through `security -i` on stdin (probed live on this Mac with a throwaway item, then deleted). The prompt-on-`-w` design was dropped, because a prompt may read the terminal rather than stdin. A value is limited to token characters, so it cannot inject a second command. The call has a timeout.
- `log.js`: fields are capped at 32 characters and `ocsk_` values are refused, so neither secret fits. `state.js`: an unreadable record stops start-up with `state-unreadable` rather than being silently replaced.

**Review.** Critic `rev-20260928T023538Z-e04e0fa7` found 0 blocking and 5 observations. O-1 (suite evidence predates the files) is accepted: the suite runs at the chunk B boundary. O-2 to O-5 (store via prompt, corrupt state, stale `posting` entries, the cut count) were fixed in this commit, along with a head-of-line block I found myself: a Discord 400 on one item stalled every later one.

**Evidence.** `test/discord-helper.test.js` (unit) and `test/discord-helper-c1.test.js` (the helper's real modules against the real channel routes: one inbound row per Discord id, nothing recorded for other authors, guilds or channels, a merge request delivered stamped, a notification held through an outage then posted and acked once, and the token refused off-channel) are green. 16 guard mutations were run; 15 turned a test red, and the 16th is equivalent (a redundant parse guard).

## 2026-09-28 — The operator channel sends server notifications (#1799)

<!-- prawduct: type=feature | scope=c15-notify-emitter-1799 -->

The PM dispatched this on the Architect's ruling for #1799: a separate PR stacked on C1 (#1966 @25f03e01, not amended) for a server-side emitter of the three events that have a source today. Plan: `.tangleclaw/plans/1799-c15-notify-emitter.md` (local, not tracked).

**Problem.** The Discord helper may call only C1's three routes, and C1's outbound carried only a project's replies, so TangleClaw had no way to tell the operator it needed attention.

**The change.**
- `lib/operator-channel-notify.js` emits `operator-needed` (watchdog `_alertOperator`), `work-blocked` (`workload.record`, on entry into `blocked`) and `fleet-idle` (the channel pump, every live lane idle, once per spell).
- Each is a closed record: type, stable key, project, timestamp and fixed server-rendered text. It is stored as a relayable outbound item (schema v52, additive), listed with `kind`/`type` and settled only by the helper's ack.
- `release-action-needed` and `certification-state-changed` are reserved and refused.
- Nothing is recorded while the channel is off.
- A notification's synthetic id is `notify/<key>`, outside the Hub id rule, and `recordArrival` refuses an arrival whose id breaks that rule. No received message can take a notification's id and suppress it.
- A project name that is not display-safe is left out ("a project") and logged, so the notice still goes.

**Review.** Critic `rev-20260928T012351Z-374bee12` found 0 blocking. Its observations were fixed: the fleet-idle episode was opened before its notice, and never closed while the channel was off; three untested failure paths; unneeded lazy requires; wording. Verify passes `rev-20260928T012758Z-4f809b73` and `rev-20260928T013019Z-483a305c` were clean. The second of them led to the stable pending key, so a crash cannot notify twice. Cumulative `rev-20260928T013906Z-c55e8d48` found 0 blocking. Its two warnings (the id collision, the silent drop on an unsafe name) were fixed, and verify `rev-20260928T014422Z-b2965cbb` was clean. The PR review found 0 blocking.

**Evidence.** The full suite is green on the final tree; its tree-valid run is in the evidence store. 25 notification tests drive each source through its real detector (the watchdog ladder, `POST /api/tc/workload`, the channel pump), plus a v51→v52 in-place upgrade and a crash between recording and opening the episode. Each hook, and the stable key, was mutation-checked by removing it and watching its test go red.

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
