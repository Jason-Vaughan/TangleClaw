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

## 2026-10-01 — Discord helper: failed writes, unexpected poll failures and a malformed base URL are answered by closed code (#1799)

<!-- prawduct: type=bugfix | scope=discord-helper-1799 -->

TC-RM18 Chunk 6, dispatched by the Architect (Medusa 4d06319a) under Rule #154, on
`feat/1799-discord-helper-on-2031-fold` from `dc8a876d`. Not committed until the Architect authorizes the
diff; not pushed. It resolves four observations of Critic `rev-20261001T005003Z-4bdc34d4` (O-1 with O-12,
O-2, O-10, O-16). Settling a multi-part or rejected reply (O-3, O-14) is left for the next chunk.

**Why:** the helper could fail without saying why. A write of its record or its lock that failed, or any
unexpected error inside a poll, reached no log code. A base URL that `configure` accepted could make `run`
and `verify` throw, so launchd restarted the helper every 30 seconds with only "unexpected TypeError" in
the log.

**What:**
- `state.js` is the one owner of the record's writes. Any failure is a `StateWriteError`
  (`state-write-failed`). A `set` or `remove` is adopted in memory only after it is on disk, so a failed
  write changes nothing in either place.
- `outbound.js` stamps an attempt's `since` on a copy and adopts it once written. A write that fails before
  a post therefore leaves no false doubt behind: without this, a disk-full spell longer than the nonce
  window held a reply as `uncertain` that had never left the helper.
- The poll's last catch now ends every failure in one closed code. The three expected failures are logged
  where they happen and rethrown as a marker; a failed write logs `state-write-failed`; anything else logs
  `outbound-pass-failed` with the error's type name and nothing of its message.
- `cli.js`: `run` answers a lock or record it cannot write with `lock-failed` or `state-write-failed` and
  exits 78 before contacting anyone. `settle` says nothing was settled (it used to print "A Discord
  message id is digits only" for a failed write).
- `loadConfig` parses the base URL. It must be `http:` or `https:` with a host and no user name or
  password. It is the one validator, so `configure` refuses the value and `run`, `verify` and `status`
  answer `config-invalid`. [DECISION] Refusing credentials goes one step past "malformed": the client uses
  the URL's origin only, so they would be silently ignored, and `status` prints the value.
- `docs/discord-helper.md` names the start command after a stop (`install-launchd`), cites the real
  heading for held replies, and explains the three new codes.
- `acquireLock` writes its private pid file inside the block that removes it, so a write that fails
  part-way leaves no file behind on each restart.
- The chunk B entry below no longer cites VRF-003, a runbook id no file holds; it points at the guide's
  verification section.

**No duplicate post under a failed write.** Tests inject the failure at each write of the record: before a
post, after a post (same process, and after a restart inside and past the nonce window), part-way through
a split reply, after the acknowledgement, and while setting a reply aside. In each, Discord receives each
part once.

**Tests (none weakened):** new cases in `test/discord-helper.test.js` (state, outbound) and
`test/discord-helper-cli.test.js` (configure, run, verify, status, settle). The write failure is injected
by a directory where the write's temp file goes, so it works on any host and as any user. One mutant per
new behaviour was run against these tests, and each turns a test red (the list is in the chunk's evidence
package).

## 2026-09-30 — Discord helper on the folded operator channel: candidate restack of #2003 (#1799, #2031)

<!-- prawduct: type=feature | scope=discord-helper-1799 -->

TC-RM18 Chunk 5, dispatched by the Architect (Medusa 180f0ac2) under Rule #154. A local candidate on
the new branch `feat/1799-discord-helper-on-2031-fold`, from `da3efde8`. Not committed until the
Architect authorizes the diff; not pushed. No existing stack branch or PR was touched.

**Why:** #2003 (the Discord helper) sat on `198acf21`, an old #2001 head, and had never been built or
tested against the folded schema-v52 operator channel. Nothing proved the two halves work together.

**What:**
- The #2003 delta (`198acf21..fff88346`, eight commits) is brought onto `da3efde8` by one three-way
  merge. Every helper code and test file arrives byte-identical to `fff88346`.
- Conflicts were documentation only, and both sides are kept: `CHANGELOG.md` (the helper's bullet is
  added; the fold's notifications bullet stands), `FEATURES.md` (the helper's entry is added; the
  fold's operator-channel entry stands), and the September change-log archive (the fold's copy stands:
  the #1956 entry stays in the live log where the fold has it, so it is not also archived).
- The helper titles the fold's `message-undelivered` notification "Message not delivered". Without the
  entry it posted under the generic "Notification".
- `docs/discord-helper.md` no longer says the helper is never told when a delivery fails; it lists the
  notification titles. `docs/operator-channel.md` drops its note about a title to add later.

**Tests (none weakened):**
- New, in `test/discord-helper-c1.test.js` (the helper's real modules against the real channel routes):
  every type in `operator-channel-notify.js#EMITTED` has a helper title; and a Discord message whose Hub
  outcome is lost settles `send_unknown`, and the helper posts the notice once, titled, as a reply to
  that Discord message.
- With the title removed, both new tests fail.

## 2026-09-30 — Harden the operator channel: arrivals, inserts, boot check, failure notices, settings log

<!-- prawduct: type=bugfix | scope=oc-schema-fold-2031 -->

TC-RM18 Chunk 4, dispatched by the Architect (Medusa 92b79e63) under Rule #154, from `47c684c6`.
Not committed until the Architect authorizes the diff; not pushed.

**Why:** the cumulative Critic over the fold and main merge left warnings and notes that the Architect
ruled must be fixed before the stack moves. The one defect a user could hit is that an arrival with a
sender id longer than 128 characters made the outbound insert throw before the Hub copy was acked, so
the Hub redelivered it on every reconnect and it was never recorded.

**What:**
- `recordArrival` keeps such an arrival quarantined (`sender-too-long`) without its sender id or text,
  then acks it. Root cause: the ON CONFLICT insert correctly stopped swallowing the column CHECK, but
  nothing bounded a value the Bridge lets any caller choose.
- `insertInbound` uses `ON CONFLICT(external_id) DO NOTHING`, so ADR 0022 decision 4 holds for every
  channel insert.
- The per-boot storage step runs the whole postcondition, the partial unique `idem_key` index
  included. The migration no longer repeats the check separately.
- New notification `message-undelivered`, raised when an operator message settles `failed` or
  `send_unknown`, keyed by the inbound row and linked through `reply_to_inbound_id`, so `GET /outbound`
  names the operator's message in `inReplyTo`. The C2 helper at `fff88346` already posts unknown types
  generically and threads anything with `inReplyTo`, so it needs no change.
- `updateSettings` logs the fields a request set and their new non-secret values at info.
- `listRelayable` drops the dead `row.kind || 'reply'` fallback and the older-helper sentence.
- ADR 0022: Accepted under the Architect's ruling; decision 4 covers inbound and the bounded sender;
  decision 5 says "in full"; decision 8 names where the number is actually written.

**Tests (none weakened):**
- New: a 129-character sender is recorded, quarantined and acked, and 128 is kept (API, through the
  real arrival observer); an inbound CHECK or NOT NULL failure throws; a mis-shaped key index (plain or
  whole-table unique) refuses to open at the current version; a notification links its message;
  failed and `send_unknown` each raise one notice, a retrying refusal none; the settings log line.
- Changed: `test/coordinator-rotation.test.js` asserts `CURRENT_SCHEMA_VERSION >= 51` instead of
  `=== 52`. The rotation test proves its own migration, and the ordering is carried by the dispatch and
  the table assertions. The notification vocabulary test lists the four emitted types, still exactly.
  The wrong-shape migration test's comment now says the boot check refuses it.

**Deferred (Architect):** retention and the `created_at` rate-limit index (W4/R-6).

## 2026-09-30 — Merge main into the #2031 fold and move the operator channel to schema v52

<!-- prawduct: type=chore | scope=oc-schema-fold-2031 -->

TC-RM18 Chunk 3, dispatched by the Architect (Medusa 26258b60) under Rule #154. `main` @ `aebd6960`
is merged with a true merge commit, with no rebase and no force-push. Not pushed.

**Why:** `main` took schema v51 for the coordinator rotation tables (#2032). Under ruling A17 the
operator channel lands after it. The fold branch was also 109 commits behind `main`, and that stale
base was why `test/projects.test.js` failed (Critic R-1).

**What:**
- Conflicts in `lib/store.js` and `server.js` both come from two independent additions, so both
  sides are kept. `_createTables` builds main's rotation tables, then the channel's storage. The
  migration dispatch is main's `< 51` rotation step, then the channel's `< 52` step.
  `CURRENT_SCHEMA_VERSION = 52`. `server.js` keeps main's `_laneRotation` and `_routePatterns`
  beside the channel's `_fleetAvailabilities`. `CHANGELOG.md` keeps both `[Unreleased]` blocks.
- The rollback target in `CHANGELOG.md` is now a v51 server, which is still one that does not
  know `operatorChannel` and so still exposes `tokenHash`. The Storage bullet names v52 (Chunk 2
  observation O-1). ADR 0022 point 8 states v52 as fact instead of a future renumber.

**Tests (renumber, not weakened):**
- `test/store-operator-channel-migration.test.js` rewinds to v51, the version before the channel,
  instead of v50. The assertions are otherwise the same.
- `test/coordinator-rotation.test.js` (#2032, from `main`) pinned `CURRENT_SCHEMA_VERSION === 51`
  and a fresh stamp of `[51]`. Both pins stay exact, now at 52 and at `[CURRENT_SCHEMA_VERSION]`.
  The upgrade test still starts from v50 and still proves the rotation tables and indexes appear.

## 2026-09-30 — Fold the operator channel's two stack migrations into one final schema (#2031)

<!-- prawduct: type=fix | scope=oc-schema-fold-2031 -->

TC-RM18 Chunk 2, dispatched by the Architect under Rule #154 (ruling A6). Not committed; not merged.

**Why:** the stack's operator channel took schema v51 (mail) and v52 (notifications), but `main`'s v51
is now the coordinator rotation tables (#2032), so both numbers collide. Notifications were also
stored under a synthetic `hub_id = 'notify/<key>'`, which made every Hub-id path carry a special
case. The two migrations never shipped, so they fold into one.

**What:**
- `lib/store.js`: one `_migrateOperatorChannel` step, still at the stack-local slot v51. It creates
  the mail tables, the notification columns, the `idem_key` partial unique index and
  `operator_channel_notify_state` in their final shape. `hub_id` is a nullable UNIQUE column. A row
  CHECK keeps a reply on `hub_id` and a notification on `idem_key` + `notify_type` with no Hub id.
  The postcondition runs at boot as well as during migration, and it refuses an old-shaped table
  with a message pointing at the recovery docs.
- Inserts use `ON CONFLICT(<key>) DO NOTHING` instead of `INSERT OR IGNORE`. OR IGNORE also
  swallows CHECK failures, and a nullable `hub_id` would have turned those failures into silent
  drops.
- `lib/operator-channel.js`: the Hub-id arrival refusal stays as a general rule. Its comment no
  longer depends on `notify/`.
- ADR 0022 records the decision and the A1–A5 routing extension boundary, which is text only and
  was not built. `docs/operator-channel.md`, `CHANGELOG.md` and `FEATURES.md` are updated.

**Requirement change (tests):** `test/operator-channel-notify.test.js` asserted
`hub_id = 'notify/<key>'` and a v51→v52 in-place upgrade. #2031 retires both. The id assertion now
expects `hub_id IS NULL`, and the upgrade test is removed because no v51→v52 step exists any more.
The v50 upgrade and the refusal of a wrong shape are covered in
`test/store-operator-channel-migration.test.js`. No test was weakened: the spoof-arrival tests keep
their assertions and gain collision cases.

## 2026-09-28 — C1.5: merge C1 (#1966) to carry main and the relay fix forward (#1799)

<!-- prawduct: type=chore | scope=c15-notify-emitter-1799 -->

Stack integration S2 (dispatched by the PM, approved by the Architect).

**Why:** #1966 now carries `main` @ `69fc2253` and the fix that relays only a project launch's own
sends to the operator's chat (`3efdca1e`). C1.5 is stacked on C1's old head `25f03e01` and had
neither. A `--no-ff` merge brings both in without rewriting C1.5. That keeps `198acf21` an ancestor,
so C2 (#2003) stays valid on top of it.

**What:** only `FEATURES.md` conflicted. The Medusa lines take C1's text, which is `main`'s current
wording. The Operator channel line combines two edits that do not overlap: C1.5's notifications
sentence and C1's launch-proof wording. Against C1, the result differs only by C1.5's own one-line
change. The rest merged cleanly, including `lib/operator-channel.js`. Notification rows are stored
`relayable` under `notify/<key>` and never pass through `resolveOutbound`, so the new sender check
leaves them alone. The schema stays at C1.5's v52.
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
- `docs/discord-helper.md` is the operator guide: the Developer Portal intent, the ids, secrets, verify, launchd, held replies, refusals and log codes. The docs that point to it were updated: operator-channel.md, FEATURES.md, PROJECT-MAP.md and CHANGELOG. The live round trip on the operator's Mac is still owed; what it must check is listed in that guide's "Verification on the operator's Mac" section. (Corrected 2026-10-01: this sentence cited a runbook id, VRF-003, that no file in the repository holds.)

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
## 2026-09-28 — Operator channel: merge main to clear #1966's conflicts (#1956)

<!-- prawduct: type=chore | scope=operator-channel-1956 -->

Stack integration S1 (dispatched by the PM, approved by the Architect).

**Why:** `main` moved 54 commits past C1's base (`c5c05a70`), and #1966 no longer merged. C1.5 (#2001)
and C2 (#2003) are stacked on C1's head `25f03e01`. A rebase would have rewritten that head, orphaned
both PRs and needed a force-push. A merge commit keeps `25f03e01` as an ancestor, so both stay valid
and untouched.

**What:** a `--no-ff` merge of `main` @ `69fc2253` into `feat/operator-channel`. Only `CHANGELOG.md` and
`FEATURES.md` conflicted, both as adjacent additions, and each is resolved as a union: `main`'s entries
as `main` has them now, plus C1's operator-channel entries unchanged. Against `main`, the resolution
adds only C1's own lines. The rest merged cleanly. Two checks found nothing to fix:
- `main` did not touch `lib/store.js` and leaves the schema at v50, so C1's v51 migration has no
  collision.
- C1's `CHANNEL_TOKEN_SCOPE` check sits in the global request dispatcher, so it also covers the
  rules and learnings routes `main` added.

**Security fix, on the Architect's ruling:** the cumulative review of the merged tree
(`rev-20260928T211036Z-a1b6674a`) found a blocking gap in C1 itself, present at the merge base.
`resolveOutbound` trusted the send's recorded sender project, and the send route fills that in
from the project in its URL. So a send through the target's own route, with no launch headers
or with another project's, was relayed to the operator's chat as the target's reply. Now only a
send recorded with `sender_verified = 1` and `sender_proof = 'launch'` qualifies. That is the
target's own launch, since `exchangeCaller` records another project's headers as unbound. The
existing project-id match still applies on top. Everything else is quarantined as
`sender-not-verified`, and operator-written mail on the target's route is quarantined too,
because it is not the project speaking. Four negative tests, each shown failing before the fix:
- a header-less send;
- another project's launch headers;
- an operator's unsolicited send;
- an operator's `inReplyTo` answer.

The existing verified reply and unsolicited-message tests are unchanged and still pass. The docs,
the CHANGELOG entry and the FEATURES line now say which senders qualify.

## 2026-09-27 — Operator channel: a chat helper's durable line to one project over Medusa (#1956)

<!-- prawduct: type=feature | scope=operator-channel-1956 -->

Discord Operator Bridge, Chunk 1: the server half. The TangleClaw-Architect authorized it directly over Medusa, building on Builder2's v2 design spike and the Architect's rulings (guild channel, GUILD_MESSAGES + MESSAGE_CONTENT, exact user+guild+channel allowlist, conversation not authority). The PM filed #1956. C2 (the Discord helper) is out of scope and not yet authorized. This work is not in v5.30 scope.

**Problem.** Nothing outside a session could reach an agent's Medusa inbox and get the reply back: the routes need a live session, `inReplyTo` needs a tracked send, and a restart retires the recipient's workspace id.

**The change.**
- **The principal.** `lib/operator-channel.js` is a non-session Medusa participant with a stable workspace id, following the Project Master precedent. Its listener runs while the channel is enabled.
- **Inbound.** Operator messages are kept durably (schema v51, `operator_channel_inbound`, unique by the chat message id). They are delivered as ordinary tracked sends from an unbound caller: normal priority only, stamped conversation-not-authority, sent when the target project has a live session. Order is kept per project, and one offline project never holds back another. A message is never sent twice: a lost Hub answer becomes `send_unknown`, and a retry after an interrupted attempt reuses its request id so the exchange record's duplicate guard catches it. A refused send retries under a fresh id, up to five attempts.
- **Outbound.** `operator_channel_outbound` is unique by Hub id. A received message is relayable only if TangleClaw recorded a send for it from the target project, or a reply from the project the answered message was delivered to. Everything else is quarantined and its text dropped, because the Bridge trusts any local `from`.
- **Auth.** The helper's `ocsk_` token is stored as a SHA-256 hash and compared in constant time. It is refused on every route but the three helper routes, at the perimeter (`CHANNEL_TOKEN_SCOPE`). Configuring the channel and minting its token are operator-only. `GET /api/config` shows only `tokenConfigured`.

**Critic.** The cumulative review rev-20260927T175741Z-c70670ed found 0 blocking. R-1 (the token hash via /api/config), R-2 (an old target's replies quarantined after a target change) and R-3 (a 50-row batch letting one offline project hide live ones) were fixed in dc283f49, and verify-resolutions rev-20260927T180526Z-7cea6b10 confirmed them. R-6 (a crash between a successful send and settling it records `send_unknown`) was accepted, since nothing is ever sent twice. O-1 (a stale `resolveOutbound` JSDoc) was fixed in the Architect-review remediation (15e68ef7).

**Tests.** Three new test files (store, unit, and API end to end over a fake Hub):
- delivery: offline-then-live delivery, replay idempotency, a lost Hub answer, retry under a fresh id after a refusal, per-project ordering past a backlog;
- replies: the `inReplyTo` round trip, a reply after a target change, quarantine of another project's mail, of mail no send made, and of oversized mail;
- fences: token scope on other routes, operator-only settings, the allowlist, length and rate limits, and the hash kept out of /api/config.

`test/workload-receipts.test.js` pinned the head schema version as a literal; it now reads `CURRENT_SCHEMA_VERSION`.

**Architect independent review of PR #1966: remediation.**
1. `PUT /config` and `POST /token` now require a verified-session operator. An ambient-open dashboard spoof or a local script is refused with `OPERATOR_VERIFICATION_REQUIRED`, and an install whose gate isn't armed cannot set the channel up.
2. The rollback docs now say that a v50 server's `/api/config` exposes `tokenHash`, so the token must be rotated after re-upgrading.
3. A relayed reply's tracked send must be addressed to the channel's own workspace; otherwise it is quarantined (`not-addressed-to-channel`).
4. The ADR 0020 §3 display-safety rule (A29/A30) is applied to chat text in both directions, with line breaks and tabs allowed. Unsafe inbound text is refused with `400 UNSAFE_TEXT`, and an unsafe reply is quarantined (`unsafe-text`).

Each has negative tests: spoofed dashboard callers on an open and an armed gate, a send addressed elsewhere, and bidi, zero-width, line-separator, soft-hyphen and BOM text. N5 is recorded as non-blocking per the Architect. N6 (cancellation and retention) carries into C2 planning.

## 2026-09-28 — Session-rule mutations are gated on a verified caller (#2013)
## 2026-09-30 — #2020: macOS 26.3 soak-tooling compatibility (RM09 census)

<!-- prawduct: type=fix | scope=2020-lease-start-form -->

PM dispatch. The TC-RM09 dry run was BLOCKED - TESTBED/TOOLING COMPATIBILITY; this is not a candidate failure (Architect rulings A3/A4). The verifier refused the real macOS 26.3 guest with `LeaseStartTime is not in the expected form (YYYY-MM-DD HH:MM:SS +ZZZZ): 09/30/2026 14:24:26`. Branch `fix/2020-lease-start-mdy` from `origin/main` `aea0c4f8`.

**Why.** macOS 26.3's `ipconfig getsummary` prints `MM/DD/YYYY HH:MM:SS`, with no zone. The verifier accepted only the zoned ISO-like form, so no real guest could be attested.

**What.**
- `deploy/soak/guest/guest-setup.sh`: `ipconfig getsummary` runs with `TZ=UTC`. RM09's real-guest census showed the zoneless form is printed in the caller's zone: the same instant printed 14:36:09 by default and 07:36:09 under `TZ=America/Los_Angeles`. The zoneless form is then read as UTC, and must round-trip through the UTC calendar, so an impossible day or time and day-first input are refused. The zoned form is unchanged. Two new attested fields, `dhcp.leaseStartForm` (`zoned` or `utc`) and `dhcp.leaseStartUtcOffsetMinutes`, record the reading.
- `test/soak-guest.test.js`: the zoneless form read as UTC whatever the admin's `TZ` (UTC, America/Los_Angeles, Asia/Kolkata), with a fake `ipconfig` that prints the start only when called under `TZ=UTC`; a zoned +0530 start read by its own offset; refusals for an impossible day, an hour of 24, day-first input, mixed forms, missing seconds, a future start and expiry.
- Census-driven (RM09 census `0a5217e6…`, real macOS 26.3 guest):
  - `LeaseExpirationTime`, when reported, must equal the start plus `lease_time`, and is attested as `dhcp.leaseExpiryRaw`.
  - `dseditgroup` exit 67 means "not a member"; any status other than 0 or 67 is refused as unknown. Before, it counted as "not a member".
  - `pfctl`'s ALTQ banner is dropped from the rules output.
  - Setup uses `sudo true` instead of `sudo -v`, and `createhomedir` for a workload user `sysadminctl` created without a home.
  - Tests use the census shapes: a `0xe10` lease with no T1/T2, both clocks zoneless and printed in the caller's zone, the census `pfctl -s info` line and the ALTQ banner.
- Docs: the README describes both clock forms, the `TZ=UTC` call, the expiry cross-check and the `dseditgroup` statuses. Runbook step 11 runs setup under `nohup` into `~/setup.log`, because the SSH session that loads pf hangs.
- Not in this PR, filed as #2064: F5/F6. The workload positive control stops at the first probe that answers, so it can't positive-control each plane separately. That changes verifier behaviour and is not a format fix.

**Decision.** An earlier revision on this branch read the zoneless form as the guest's local time and documented a zone-error branch in runbook step 12. RM09's census showed `ipconfig` formats in its caller's zone, so pinning the caller to UTC removes the assumption entirely, and that branch is gone.

**Test contract changed, not weakened.** The admin-line `deepEqual` gains `leaseStartForm: 'zoned'` and `leaseStartUtcOffsetMinutes: 0`.

## 2026-09-30 — #2020: derive DHCP renewal and rebinding times for a Tart lease that omits both

<!-- prawduct: type=fix | scope=2020-dhcp-timing -->

PM dispatch (Route A, operator's blanket approval). The Architect released Builder2 from standby for this chunk only. Branch `fix/2020-dhcp-timing-derivation` from `origin/main` `75c499f1`.

**Why.** Tart's vmnet DHCP server sends a lease with `lease_time` but no `renewal_t1_time_value` or `rebinding_t2_time_value`. The admin verifier required all three, so it could never attest a Tart guest.

**What.**
- `deploy/soak/guest/guest-setup.sh`: when both timers are absent, T1 = floor(lease/2) and T2 = floor(lease*7/8) (RFC 2131 4.4.5). A lease with only one timer is still refused, and the message names which one it reports. The new field `dhcp.timingSource` is `lease` or `derived-rfc2131`. The server identity, start/expiry, strict ordering and remaining-window checks all apply to derived times, unchanged.
- `test/soak-guest.test.js`: explicit timings (`timingSource: 'lease'`); both absent, the Tart shape; rounding down; partial absence refused either way round; missing `lease_time`; leases too short for ordered derived timers; a duplicate `lease_time`; a malformed timer; expiry; and the remaining window.
- Docs: the README explains the derivation and that a derived time is not evidence of renewal. New install-runbook step 12 observes SSH and the address surviving a real renewal on the dry run. Static addressing is the fallback only if that fails. Step 11 now has the host confirm the lease's server before `SOAK_DHCP_SERVER` is exported: no step set it, so setup could not succeed as written.

**Test contract changed, not weakened.** The admin-line `deepEqual` gains `timingSource: 'lease'`. The existing partial-absence test now also requires the refusal to name the timer the lease reports.

## 2026-09-29 — #2020 Chunk 3: fault and browser executors, integrity sampling, evidence bundle, operator runbooks

<!-- prawduct: type=feature | scope=2020-chunk-3 -->

Lease Rule #142 (RM-LEASE TC-RM08 generation 3). PM dispatch `fe7c8a9d`. Branch `feat/2020-chunk3-soak-runbook-executors` from `origin/main` `a5253de6`.

**Why.** The schedule already drew `browser` and `fault` events, but `run` refused them (`NO_EXECUTOR`). Nothing sampled the guest database or the server process, nothing gathered a run into one evidence set, and no procedure installed the pinned candidate in the guest. The Architect ruling on #2020 requires all of it before the dry run.

**What.**
- **3a: local control and faults.** `lib/soak/local.js` admits a schedule with any fault or browser kind only inside the guest: `--no-live-install`, `kern.hv_vmm_present` = 1, a loopback IP `--api`, and an owned `--home` with its `tangleclaw.db`. Otherwise it refuses with `LOCAL_CONTROL_REFUSED` before any load. `lib/soak/faults.js` implements the six faults (the table is in `deploy/soak/README.md`).
- **3b: browser events.** `lib/soak/webdriver.js` is a minimal W3C client, and `lib/soak/browser.js` implements the dashboard load and the terminal attach. The attach is proven by the server's `pty-activity` counter on the same instance.
- **3c: sampling and the bundle.** `lib/soak/integrity.js` backs `soak sample`: database check verdicts, RSS and descriptors, disk, and health. `lib/soak/bundle.js` backs `soak bundle`: copies, a `VACUUM INTO` snapshot checked with `integrity_check`, and a sha256 manifest. Both are admitted by `local.admitGuestReader`.
- **3d: runbooks and docs.** `docs/runbooks/soak-install-the-candidate.md` and `docs/runbooks/soak-run-sample-and-bundle.md`. `deploy/soak/README.md`, CHANGELOG and FEATURES are updated too.

**Decisions.**
- The server restart goes through `POST /api/server/restart`, and is never forced past a wrap.
- The tmux kill targets only the session the harness's own launch named (`=<name>`).
- The ttyd restart reuses `lib/ttyd-watcher.js`'s kickstart form, and refuses outside the destructive phase.
- Disk ballast leaves 2 GiB free, is capped at 64 GiB, and is swept at the start of the next disk fault.
- `lib/soak/` stays self-contained, so the guest's checkout trust check (`lib/soak/*.js`) still covers everything the soak runs. That is why the pidfile is parsed locally.

**Test contract changed, not weakened.** `test/soak-cli.test.js` expected `NO_EXECUTOR` for a full schedule. Every kind now has an executor, and the new guard is what stops a full schedule outside the guest. The test now expects `LOCAL_CONTROL_REFUSED` with no request sent and no log written. A new test pins an executor for every catalogue kind.

**Ruling A1.** The workload user had no GUI login session (it was created with a password nobody keeps). But the product restarts the server and ttyd through launchd `gui/<uid>`. The Architect ruled option A (exchange `mx_2MqeMZK9ZwoqbQr5`):
- a login secret generated inside the guest, never exposed;
- guest-only auto-login;
- `launchctl print` checks of the domain and both labels;
- fail closed otherwise, and no `nohup` fallback;
- auto-login disabled at teardown.

Install runbook steps 8 and 10 carry this, and the run runbook's step 9 carries the teardown. **Still open:** which macOS commands set that password with no command-line argument is not provable from the host. Step 8 marks it for the dry run to prove, with the no-argv constraint written as a stop condition.

**Review.** Cumulative `rev-20260929T232557Z-d0b342f2`: 0 blocking, 4 warnings, 6 notes. The code findings were fixed in `e8b1f356`, and verify-resolutions `rev-20260929T233248Z-a6f74105` confirmed them with 0 new findings. Its observation that the runbook's gap check assumed the default interval was fixed with the ruling edits: the bundle now reports the run's own `intervalMs`.

**Pre-existing test fixed, by PM ruling (1).** The full suite at `07c92aa5` failed one case in `test/soak-guest.test.js`, a file this branch had not touched. Its lease fixture (300 s left) was built when the file loaded, so in a run longer than that the lease had really expired by the time the case ran. It passed when run alone. The fixture is now built when the case runs, and the case's contract is unchanged.

**Verification.** Unit and integration tests use fakes for HTTP, WebDriver, launchctl, tmux and statfs, and a real SQLite database and real files. Nothing was run in a real guest: the runbooks mark those steps unverified until the first dry run.

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
