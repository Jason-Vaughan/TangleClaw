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

## 2026-10-11 — #2272: the server tells the operator when the Discord helper has had no connection for five minutes, and once when it is back

<!-- prawduct: type=feature | scope=bridge-2272 -->

#2272 Chunk 05 of five, the last. Branch `fix/2272-gateway-outage-notice`, from `origin/main` `5f55e3a9`. No schema change.

Visual change: no

**Why.** The Discord helper lost its Gateway connection for twelve hours and went on posting, so the operator's replies reached nobody and nothing told them (#2272). The earlier chunks made the helper recover, report its connection and show it on the page, and admitted two notification types. This one raises them: a notice the operator reads in the chat, which is the one place they were looking.

**What changed.**
- `lib/bridge-notify.js`: one producer, `_gatewayOutage`, with its line in `reconcile` and a count, `gatewayOutage`, in the pass's result. It reads the helper's report through a new seam, `_deps.discordReading`, which requires `lib/bridge-gateway.js` when called: that module already requires this one. `GATEWAY_DOWN_AFTER_MS` is the five minutes.
- `docs/operator-bridge.md`, `docs/discord-operator-notifications.md` and ADR 0023: the two types as raised, when each is and what raises neither.

**Decisions.** All but the last two are ruling 27's (`c05 decisions ok`), written here as built.
- [DECISION: the five minutes count from the latest of the helper's own time for the outage, this process's first reading of it as down, and the bridge's enable time. | A wrong helper clock, a server just started and a bridge just enabled each cost a delay; none can raise a notice for an outage this server has not watched for five minutes.]
- [DECISION: one outage runs from its notice to the next reading that says connected, and the queue's rows are the record. | A helper restarted mid-outage restarts its own count and a server restart forgets what it saw; neither may announce twice.]
- [DECISION: a refused connection raises the notice after the same five minutes. | Ruling 8 (`fatal yes`). Its sentence says it will not come back by itself.]
- [DECISION: a missing or stale report neither opens an outage nor closes one, and does not restart the wait. | A helper polling slower than the staleness limit reads not-reported while it runs. Restarting the wait on it would mean such a helper's outage is never announced.]
- [DECISION: recovery is announced only for an outage whose notice was not let go. | A notice nobody collected was never seen.]
- [DECISION: an outage still open after retention removed its posted notice is announced once more. | Ruling 27: intended, as a reminder.]
- [DECISION: a `gateway-down` let go uncollected holds no outage open, and if the helper still reports that outage it is announced again as a new notice with its first beginning. | Ruling 28. Ruling 27 has no recovery follow a notice nobody saw, so nothing would close it and every later outage would go unannounced. And the helper that could not post for a week and still has no connection is the case this issue is about: letting the notice go ends the announcement, not the outage. The new notice is keyed by the one let go, so it cannot repeat faster than the 7-day limit.]
- [DECISION: a helper restarted after its notice was let go is announced from the beginning it now reports. | Its report no longer carries the first beginning, and with no notice the operator saw the server has no record to tell it from a new outage.]
- [DECISION: the recovery notice is keyed by the beginning its outage's notice was raised for, and gives the length from there. | One recovery per announced outage, and the length the operator was first told to count from, whatever a restarted helper reports since.]

**Existing assertions changed, each still exact.** `test/bridge-notify.test.js` holds `reconcile()`'s whole result in three cases: 'delivers no backlog...' (the disabled pass), 'one kind failing does not stop the others' and 'a pass that cannot read the facts raises nothing for them...'. Each held four counts and holds five, with `gatewayOutage: 0`.

**Checked.** `test/bridge-notify.test.js` alone and with the bridge's API, retention and migration files. Each rule was taken out of the producer in turn and the file run: dropping any of the three starting times, counting strictly more than five minutes, letting a let-go notice hold an outage open, not announcing again an outage whose notice was let go, announcing while one is open, restarting the wait on a missing report, not ending a run of down readings on a connected one, and measuring the recovery's length from the wrong time each fail at least one case. One case goes through the gateway's real `recordDiscordReport` and `discordReading`, staleness limit included.

**Not covered.** No notice of either type has been raised on a live install, and none will be staged: a real one means keeping the live helper off Discord for five minutes. Tests only. The sentences have not been read on a phone.

## 2026-10-11 — #2272: the operator bridge admits two notification types about the helper's own connection (schema v63)

<!-- prawduct: type=feature | scope=bridge-2272 -->

#2272 Chunk 04 of five. Branch `fix/2272-gateway-notification-types`, from `origin/main` `c80716fa`. Schema v63, granted to this chunk alone.

Visual change: no

**Why.** The Discord helper can lose its Gateway connection and keep posting, so the operator's messages reach nobody and nothing says so (#2272). The operator ruled that the server queues a notice after five minutes and announces the recovery once. A notice is a typed row in `bridge_outbound`, and its types are a CHECK that SQLite changes only by rebuilding the table. This chunk admits the two types and writes their sentences. Nothing raises them yet: the pass that does is the next chunk.

**What changed.**
- `lib/bridge-schema.js`: `NOTIFICATION_TYPES` gains `gateway-down` and `gateway-recovered`; `bridge_outbound` gains `needsSince63`; `LATER_VERSIONS` gains 63; `BRIDGE_SCHEMA_VERSION` is 63.
- `lib/store.js`: `CURRENT_SCHEMA_VERSION` is 63, with the step `_migrateOperatorBridgeV63`. It proves the store is a sound v62 store, rebuilds the one table with every row, column and id carried over, and has nothing to do on a store already in the v63 shape.
- `lib/bridge-store.js`: retention limits for both types.
- `lib/bridge-notify.js`: the two templates, the reasons Discord refuses a connection (`GATEWAY_REFUSED`), and a seam for the zone a notice's times are shown in. No producer and no line in `reconcile`.
- `docs/operator-bridge.md` and ADR 0023: the two types as admitted and not raised, their sentences, the v63 migration, the limits.

**Decisions.**
- [DECISION: the sentences land here, one chunk ahead of their producer. | `test/bridge-notify.test.js` holds every admitted type to a template, so a type cannot be admitted without one. The Integrator chose this over joining the two chunks.]
- [DECISION: a refused connection has its own sentence, with the reason, and never the wording of a retry. | Ruling 8 (`fatal yes`): it is the one outage that will not end by itself.]
- [DECISION: times are the host's local time with its zone, and UTC, said as UTC, where the runtime cannot name the zone. | Ruling 27 (`times local`): the operator reads these on a phone. A time is never shown without a zone.]
- [DECISION: both notices tell the operator that what they sent may need sending again. | Ruling 27. "May not have arrived" for the recovery, because a short drop that resumes can replay what was missed.]
- [DECISION: `gateway-down` keeps 7 days and `gateway-recovered` 1 day. | The first is still so until the connection is back; the second describes a moment. Ruling 27 (`retention ok`).]
- [DECISION: the v63 step refuses a store with no bridge table, where v62 created one. | Every start since v52 creates the bridge's storage, so a v62 store without it has lost it.]
- [DECISION: a length of time or a moment the template cannot read is left out or said to be unrecorded, never printed as given. | The templates take closed values; this keeps them so if a caller is wrong.]

**Existing assertions changed, each still exact.** In `test/store-bridge-migration.test.js`: `BRIDGE_SCHEMA_VERSION` and `CURRENT_SCHEMA_VERSION` 62 to 63; the stamp a v61 store ends on, 62 to 63, in two cases; the whole type list, four to six; the list of versions a store is a superset of gains 63. Its `rewindToV61` helper now also takes the two new types out of the table it calls v61 and asserts none of the three remains. In `test/bridge-retention.test.js`: the whole limits table gains two entries. In `test/bridge-notify.test.js`: the list of template keys, four to six. Three helpers of the migration file moved to its top level, unchanged, so the v62 and v63 cases share them.

**Checked.** The three test files, each alone. The new migration cases start from a store the code made, filled through the bridge's own writers with an item in every state and a `lane-silent` notice, then given a reply, a question and a candidate item so that every kind the queue knows is in it, and turned into a v62 store by exact SQL. With the v63 step taken out, seven of the nine new cases fail. With a "no bridge table" branch like v62's put in, the case for that refusal fails.

**Not covered.** Nothing raises either type, so no notice of these types has been queued, posted or read by anyone. The sentences are held by tests only. The migration has not run on the live database: that is the deploy's check.

## 2026-10-11 — #2057: the Codex startup-control tests order their fakes by the adapter's progress, not by timers

<!-- prawduct: type=bugfix | scope=2057-codex-receipt-poll-case -->

#2057 Chunk 01, the plan's only chunk. Branch `fix/2057-codex-fake-timers`, from `origin/main` `4cb79a8b`. A test file only; `lib/startup-control-codex.js` is not changed.

Visual change: no

**Why.** Six cases in `test/startup-control-codex.test.js` had the fake app-server act on a wall-clock timer started in its `turn/start` handler. Each assumed the adapter would reach a given step inside that delay, and a busy host breaks the assumption. The issue's case ("an accepted turn whose end no notification reports is still settled from the record by the poll") ended the turn 60 ms after `turn/start`. The adapter makes two round trips before its first read of the record; when that read lands after the 60 ms it finds a turn already ended and carrying the echoed message, accepts and settles in that one call, and the poll never runs, so "the record was re-read" is false. The race is that first read against the fake's timer; the 25 ms poll interval is not part of it. Earlier fixes in this file each removed the timer from the one case that had just failed and left the rest.

**What changed.** `test/startup-control-codex.test.js` only. Each fake now acts on an event of the adapter's own:
- The poll case ends the turn on the fake's `request` event for the adapter's first `thread/turns/list`. The fake emits that event after it has written the answer, so the first read always answers "in progress" and only a later read can answer "completed".
- The three after-acceptance cases (a socket lost, the channel lost for good, a protocol fault) start the fire, wait for its `accepted` patch, and only then take the step. On a timer, a slow first read meant the step landed before acceptance and the case passed by another path.
- The two cases that send an early summary-shaped `turn/completed` send it on the fake's `request` event for the adapter's `thread/resume`. The adapter drops a completion for a turn id it has not been given, and it asks to subscribe only after it has the id; sent then, the completion is on the wire ahead of every read-back answer. On a 1 ms timer the completion could arrive together with the `turn/start` answer and be dropped, and the case passed from the read-back alone.
- Two helpers: `startFire` (a fire that is not awaited) and `afterFirstRequest` (run a step once, after the fake answered the adapter's first request of a method).
- Every existing assertion stays as written. Each case gains one that pins the order it depends on: what each read saw and the order of the last two patches (the poll case); the fire's outcome at the moment of the loss or fault (the three after-acceptance cases); that no read of the list had been asked for when the completion was sent (the two early-completion cases).
- No fake-side timer is left in the file. Its two remaining `setTimeout` calls are waits that loop until a condition holds and race nothing.

**Decisions.**
- [DECISION: all six fake-side timers in this one chunk, not only the failing case. | Ruled `2057 all timers` by TangleClaw-Builder1: fixing the next one after it fails is the pattern to end.]
- [DECISION: the poll case keeps a real 25 ms poll interval and the adapter gets no clock seam. | Nothing races the interval once the fake's timer is gone; it decides only how long the case takes. Shown by running the case with the interval at 1 ms and at 500 ms.]
- [DECISION: the after-acceptance cases wait for the `accepted` patch and not for a request event. | Destroying a socket straight after an answer is written may discard the answer; the patch is the adapter's own statement that acceptance happened.]

**Checked.** Each run was the one file, alone, one process at a time. On `main`'s version with the poll case's turn ended inside `turn/start` (the losing order made certain), that case failed on "the record was re-read". As built the file passed three times, and with the poll interval at 1 ms and at 500 ms. Each new assertion was shown to bite against a scratch copy: the turn ended inside `turn/start` failed "the first read saw the turn still running"; the step taken at the `turn/start` request, before acceptance, failed all three after-acceptance cases on their new assertion alone, their older assertions still passing; with the adapter's read-back removed from its not-yet-accepted branch both early-completion cases settled `failed`; with an unreadable list read as absence the unreadable-list case settled `failed`; with the adapter's poll never started the poll case did not settle. The junit reports are kept in the lane's evidence directory and the PR lists every run.

**Not covered.** The reproduction first tried, `main`'s 60 ms timer set to 0, passed: in one process the adapter's first read can still land inside a zero-delay timer, so only ending the turn inside the handler made the losing order certain. The poll-removed run ended by the runner's timeout for the file, which shows the case did not settle and nothing finer. The three after-acceptance cases still wait on real reconnect pauses of 5 and 10 ms, which are the adapter's own behaviour under test and not a fake's clock. The PR says which full-suite run stands behind the head it was marked ready on.
## 2026-10-11 — #2272: the operator bridge panel says how the helper's Discord connection reads

<!-- prawduct: type=feature | scope=bridge-2272 -->
#2272 Chunk 03 of five. Branch `fix/2272-panel-discord-reading`, from `origin/main` `0e4fc49c`.

Visual change: yes

**Why.** Chunk 02 made the helper's Gateway state something the server holds and `tc bridge status` prints. The operator does not run `tc`: they open the dashboard. Until this chunk the panel that shows whether the bridge is enabled said nothing about whether the helper is connected to Discord, which is the one condition under which nothing they write arrives while everything else looks well.

**What it draws.** One line, **Discord connection**, among the panel's status lines, after **To post**, from `discordGateway` on `GET /api/bridge/operator/status`. No control, no route, no request of its own: it is read when the panel is, and when any control is pressed, Refresh included. The words are `public/operator-bridge-panel.js#discordWords`, a pure function of the reading and whether the bridge is enabled:
- `connected`: connected since a time, with the time of the helper's report.
- `down`: **NOT CONNECTED** since a time, with the helper's own word for what it is doing, and that nothing written in the chat arrives meanwhile.
- `down` with state `fatal`: **REFUSED by Discord**, the close code, and for 4004 and 4014 what it means (a bad bot token; Message Content Intent off), and that the helper will not retry until it is put right and restarted. A refusal is never worded as a connection that is retrying, nor the other way round.
- `not-reported`: not reported since the time the helper was last heard, what it last said, and that whether Discord is connected is not known.
- `never-reported`: never reported since this server started, and to restart the helper after an update.

**Decided here.**
- The line says what `tc bridge status` says, in the same order, so the Project Master and the operator are told the same thing. Two differences, both deliberate: the panel names the two refusals an operator can put right, because the operator is the one who will; and it says "nothing you write", where the Master is told "nothing the operator writes".
- A status with no `discordGateway`, one that is not an object, or one whose reading the page does not know draws NO line, and the rest of the panel is the same character for character. A server not yet deployed says nothing of the connection, and the page must not invent a reading for it.
- On a disabled bridge the `not-reported` and `never-reported` lines end by saying that a disabled bridge does not read the helper's reports, so the silence says nothing about the helper. `connected` and `down` do not: a report that was read says what it says.
- Times are shown exactly as the server gave them, escaped, as the panel shows every other time. No local-time formatting is added for this one line.
- Any close code other than the two named is shown as its number alone. The four others the helper treats as fatal are not ones an operator's settings cause.
- No style rule is added: the line is the panel's existing `.ob-line` with its `.ob-label` and `.ob-value`. `public/style.css` is untouched.
- `public/sw.js` is untouched: the panel's script is fetched network-first, so `scripts/cache-bump-guard.js` asks for no `CACHE_NAME` change.

**Tests.** `test/operator-bridge-panel.test.js`, a new block, the panel's real script run in a sandbox: each reading's whole line, compared as a whole string, with the two named refusals and an unnamed one; no line, and an otherwise identical panel, for a status without the field and for eight things that are not a reading the page knows (`constructor` and `toString` among them); with a line, that the line is the only difference, sits between **To post** and the allowlist, and adds no control; every value in the reading drawn as text when it is markup; the disabled sentence on the two silent readings only; and against the real status handler on a real store, never reported, then a report recorded through the server's own functions read as connected, as refused, and three minutes and a second later as not reported. The file's existing cases pass unmodified.

**Docs.** `docs/operator-bridge.md`: "The dashboard panel" gains the line, a table of what it says for each reading, the disabled sentence, when no line is drawn, and that it does not update by itself; "The helper's Discord connection" no longer says the panel does not show the reading.

**Not covered.** No browser has drawn this line: no scratch server was run on this host (the Integrator's word, 2026-10-11), and the check is deferred to after the deploy under ruling 10, by TangleClaw-Builder1 with the Operator's browser. What only a browser can show: how the longest line (a refusal) wraps at 375 and 320 pixels beside its label, and that nothing else on the panel moved. The line does not refresh by itself, so a panel left open shows the reading as of when it was opened. Nothing is notified (Chunks 04 and 05).

## 2026-10-11 — #2210: the soak-guest test stops racing a 2-second probe bound it chose itself

<!-- prawduct: type=bugfix | scope=2210-soak-guest-probe-bound -->
#2210 Chunk 01, the plan's only chunk. Branch `fix/2210-soak-guest-probe-bound`, from `origin/main` `a7e69797`. A test file only; nothing under `deploy/` changes.

Visual change: no

**Why.** `test/soak-guest.test.js` told `deploy/soak/guest/guest-setup.sh` to kill every probe after 2 seconds (`SOAK_PROBE_TIMEOUT`, set in the test's `setup()` helper), then answered each probe with a fake that exits at once. On a loaded host a fake can take longer than 2 seconds to start and exit. The script then reads the kill as a hang, which is the right answer for a script that cannot tell, and the case reaches a different refusal than the one it pins. Three reports in the issue are three callers of that one bound: "IPv4 loopback is unreachable", "no DHCP lease", and "a DNS query to 1.1.1.1 over UDP hung past 2s". The last failed a full-suite run on 2026-10-11 whose change had nothing to do with it. The 2 seconds was never production's setting: `guest.conf` defaults the bound to 10.

**What changed.** `test/soak-guest.test.js` only:
- Two named bounds. `setup()` and the one direct call that passed 2 now pass 60 seconds: a bound no fake that exits at once should reach, so the refusal a case pins no longer depends on how busy the host is.
- The cases that need a probe to hang pass 6 seconds themselves (the four table rows and two calls whose fake sleeps 30 seconds), and so does the case where the stub hub never answers, because the script tries the hub once a second for the whole bound. The assertion that quoted "hung past 2s" builds its text from the same constant.
- The wall-clock check on every `--verify-workload` failure case goes from 15 to 25 seconds. It shows the watchdog ended a hung probe before the fake's own 30-second sleep did; 25 is still inside 30, so a watchdog that does nothing still fails the case. With a 6-second wait in place of 2, the rest of such a case had 9 seconds of room where it had 13.
- No case is added or removed, no fake changes, and no other assertion changes. The script, `guest.conf` and their defaults are untouched.

**Decisions.**
- [DECISION: the hang cases wait 6 seconds, not 2. | Ruled `2210 hang middle` by TangleClaw-Builder1: at 2 seconds they keep the exposure the issue reports. It costs about 4 seconds for each probe that hangs.]
- [DECISION: one existing assertion's number changes, 15000 to 25000 ms. | The plan said no other assertion changes; it had not seen that three hang cases sit under this check. Ruled `2210 watchdog 25` by TangleClaw-Builder1: the property is that the watchdog beat the fake's sleep, the fake's 30 seconds is the real ceiling, and each hang case also pins the refusal's reason, which does not depend on the clock.]
- [DECISION: neither of the issue's two suggested routes. | Making two checks deterministic for one case fixes one case of the file; accepting any early refusal and pinning the 400 separately loosens an assertion.]

**Checked.** In a scratch copy outside the checkout, every generated fake was given a 3-second sleep: a fake that exits at once but takes longer than 2 seconds to do it. The two reported cases ("setup cannot be finished" and "the projects directory is the TCC-protected default") failed on `main`'s version of the file, each with "en0 has no DHCP lease to attest", and passed as built. With every fake's 30-second sleep turned into an immediate exit, each of the six hang cases went red; the three under the wall-clock check went red again after its number changed. The file run alone passed on `main` and as built with the same cases; against `main`, the only cases that took over 3 seconds longer were hang cases, by 3.3 to 4.0 seconds each. The junit reports are kept in the lane's evidence directory and their numbers are in the PR.

**Not covered.** The hang cases and the stub-hub case still depend on the host: every probe that runs before the one meant to hang is under the 6-second bound too, so at loads far above those seen so far such a case can still be refused early. 6 seconds is a smaller exposure, not proof of none. The built file was run alone once, not the three times the plan asked, and the full suite had not run when this entry was written; both were held back while the host was kept quiet for another lane's run, and the PR says what was run by the time it was marked ready. The other load-sensitive test the issue mentions in passing (`test/startup-control-codex.test.js`) is not this chunk's.
## 2026-10-10 — #2272: the Discord helper says how its Gateway connection is, and the bridge says what it reads from that

<!-- prawduct: type=feature | scope=bridge-2272 -->
#2272 Chunk 02 of five. Branch `fix/2272-gateway-state-report`, from `origin/main` `7d2304fa`.

Visual change: no

**Why.** While the helper's Gateway connection is down, nothing the operator writes in Discord reaches TangleClaw, and nothing in TangleClaw shows it: notices still post over REST, the bridge reads enabled, and the only trace is a line in the helper's own log on the helper's own machine. Chunk 01 stopped the connection from hanging for good. This chunk makes its state something the server holds, so that the Project Master can read it now and the later chunks can show it on the panel and raise a notice from it.

**What the helper sends.** `discordGateway` on the outbound claim it already makes on every pass: `state` (the gateway's own word), `since`, and `fatalCloseCode` for a refused connection only. No route, no request and no token scope is added; `lib/bridge-helper/bridge-client.js` still builds six paths. `since` is the time to count from: when the connection became ready, or since when it has not been.

**The time an outage began.** Chunk 01's `status().since` is when the current state began, and a gateway that is down moves between `connecting` and `reconnecting` on every attempt, so it restarts and never says how long the outage has lasted. `gateway.status()` gains `notReadySince`: when the gateway last stopped being ready, or when it was first started if it has not been ready yet; null while it is ready. It is kept in `setState`, from the same clock reading as `since`. A stop, and a start after it, do not move it.

**A refused gateway says `fatal` after a stop and a start.** It used to say `stopped`, which reads as something a start cures, while `start()` on it connects nothing. Found by the Critic on Chunk 01 and carried here because this is where the word starts to be reported.

**What the server does with it.** `lib/bridge-gateway.js#discordReport` admits closed values only: one of the six states, a time exactly as `toISOString` writes one (held to the round trip, so a 30th of February is refused), and a close code that is a whole number from 1000 to 4999 when the state is `fatal` and absent or null otherwise; any other key refuses it. `lib/bridge-api.js#helperClaim` refuses a claim whose `discordGateway` is not one with `400 BAD_GATEWAY_REPORT` before anything is leased, and the last good report stays. A claim with no `discordGateway` is answered exactly as before. A good report is kept when the claim was well formed, including one answered `409 BRIDGE_CONFIGURATION_BLOCKED` (the helper asked, so it is running), and not when the claim itself is `400 BAD_CLAIM`. The report is held in memory with the server's time of receipt; nothing is stored, and there is no migration.

**The reading.** `discordGateway: {reading, state, since, fatalCloseCode, reportedAt}` on `GET /api/bridge/operator/status` and `GET /api/bridge/master/status`: `connected`, `down`, `not-reported` (the last report is older than three minutes, whatever it said: a helper that died still said `ready`), or `never-reported` (none since the server started). `tc bridge status` prints one more line, `Discord connection: ...`, for each of the four, and for `fatal` says the close code and that the helper will not retry. No verb is added or renamed: `node scripts/sync-claude-md-block.js` exits 0 and `CLAUDE.md` is untouched.

**After the review.** A refused report is logged by the server (`Bridge request refused`, `BAD_GATEWAY_REPORT`): a helper whose report is refused on every pass is handed nothing, and its own log says only `claim-failed` with 400. And on a disabled bridge, which refuses the claim before reading the report, `tc bridge status` adds that a silent reading then says nothing about the helper.

**Decided here.**
- The report is recorded after the claim is answered, and only if the claim was not itself malformed, so a request the bridge calls bad changes nothing at all. A circuit refusal is not a bad request.
- An explicit `discordGateway: null` is refused like any other non-report. A helper with nothing to say leaves the field out.
- The field is called `discordGateway` in the claim and in both payloads, not `gateway`: on the server `gateway` already means the bridge's own module.
- The reading keeps what the stale report said (`state`, `since`) beside `not-reported`, so a reader can say "last said ready" without being told it is connected.

**Not done, and why.** The Critic's other note on Chunk 01 was that `ready` could be shown with no socket for up to a minute. I read every path that drops a ready gateway's socket (a missed heartbeat, RECONNECT, a bad HELLO, an invalid session, a close, a stop): each moves the state in the same call. No path leaves `ready` without a socket, so a clause deriving the word from the socket could not be turned red by any test, and it is not written. What covers the case that matters, a helper that died while saying `ready`, is the three-minute rule on the server.

**One existing assertion changed, and why that is not a weakening.** `test/api-bridge.test.js` held the Master's whole status body to six fields with `deepEqual`. The body has seven now, by this chunk's own deliverable, so the expected object gains `discordGateway` as `never-reported`. It still holds the whole body. The plan's criterion 6 said every existing case would pass unmodified; it could not for this one assertion, and the plan is amended to say so. Every other existing case in the six files passes as it was.

**Tests.** `test/api-bridge-gateway.test.js`, a new block: never reported, and a claim with no report answered as before; a report accepted, the claim's answer unchanged, both payloads and the printed line for connected, down and fatal; a table of things that are not a report, each refused with nothing leased and the reading unmoved, and a malformed claim recording nothing; three minutes exactly still current and one millisecond more not; a circuit-refused claim still recorded; and the helper's real gateway driven through all six states with each report admitted by the server's rule, so the two halves cannot drift apart. `test/bridge-helper-gateway.test.js`: `notReadySince` through two failed attempts, a ready session, a drop, three more failed attempts, a resume, a stop and a start; `fatal` after a stop and a start. `test/bridge-helper-units.test.js`: the claim's body with and without the report; the mapping. `test/bridge-helper-relay.test.js`, against the real server: every pass reports, one with nothing to post included; a claim asked again says how the connection is now; a refused pass changes nothing; a relay given no gateway reports nothing; and the end-to-end `run` case reads `connected` on the server with the gateway's own `since`.

**Mutations, in a scratch copy.** Each condition and call site this chunk adds was inverted or removed in turn and the narrow files run against it; the list and what each run answered are in the PR.

**Docs.** `docs/operator-bridge.md` gains "The helper's Discord connection" (the field, the rule, what is kept, the four readings and the line each prints, and why a slow helper can read `not-reported` while running), the claim row, the refusal list, the status row and the `tc bridge status` row. `docs/operator-bridge-helper.md` gains `notReadySince`, "Telling TangleClaw how the connection is" and one more line under what is not proven.

**Not covered.** No screen shows the reading (Chunk 03) and nothing is notified (Chunks 04 and 05). A helper configured with `pollSeconds` above 180, or backing off after failed passes, reads `not-reported` between passes while it runs; the doc says so, and Chunk 05 must not treat `not-reported` as an outage. `since` is the helper's clock and is not bounded here; Chunk 05 bounds what it times by the server's receipt. Not proved against Discord: what the live helper reports during a real outage.

## 2026-10-11 — #1999: the setup-scan own-install test stops walking the host's real Projects folder

<!-- prawduct: type=bugfix | scope=1999-setup-scan-test-hermetic -->
#1999 Chunk 01, the plan's only chunk. Branch `fix/1999-setup-scan-hermetic`, from `origin/main` `5ee6452f`. A test file only; no product file changes.

Visual change: no

**Why.** Three cases of `test/setup-scan-own-install.test.js` scanned the directory the checkout sits in, two of them against a 30-second wall clock. The walk runs a git probe for every subdirectory, so the result depended on how many clones the host holds and how loaded it is. On 2026-10-11 it gave up at 105 of 114 in a full suite and failed a run whose change had nothing to do with it; the issue had reported 69 of 78 two weeks earlier. The third case could not fail, but on a host with a large folder it returned early and asserted nothing. A test must not depend on what sits beside the checkout.

**What changed.** `test/setup-scan-own-install.test.js` only:
- The two child-level cases walk a parent the file creates: a stand-in for the running checkout, a neighbouring project, a plain directory, a hidden directory and a file. The child is told which realpath is "us" by argument, so a created directory can stand for the checkout. Both cases now also hold the listing itself, so a walk that returned fewer or more entries fails.
- The full-chain case runs the real route in a separate `node` process started from a clone that sits beside a known neighbour, with the working tree's `lib/` laid over the clone, its own data directory, and none of the session's launch identity or tmux. The answer must be `ok`, offer the neighbour and not the clone. Its early return for a scan that did not finish is gone: against two directories, not finishing is a failure.
- One case is added: a checkout that sits elsewhere and shares a neighbour's directory name marks nothing.
- The scanner, the route and the 30-second budget the cases pass are unchanged.

**Decisions.**
- [DECISION: the full-chain case makes its own clone rather than reusing the one the "clone living elsewhere" case makes. | The plan said reuse. Reusing would make one case depend on another having run first, and adding the neighbour to that case's parent would change its assertion; the plan also says that case is not changed. A second shallow clone costs about a second.]
- [DECISION: a sixth case, not in the plan. | The plan's own criterion: each property is broken on purpose and must turn a case red. Marking by directory name instead of realpath turned none red in a checkout whose folder is not named `TangleClaw`. The existing clone case catches it only where the running checkout carries that name, which is true in CI and false in every lane clone. That was so on `main` too. The property is "identity, never name", so it is held directly.]
- [DECISION: no seam in `lib/projects.js`. | Ruled `1999 chain clone` by the Integrator: the child already takes the directory and the identity as arguments, and a process started from a clone gives the route a different "running checkout" with no product change.]

**Checked.** Each property broken in a scratch clone, one at a time, and restored by sha256: comparing the spelled path instead of the realpath (the symlinked-route case and the full-chain case go red); marking by name (the added case); marking everything when no identity is given (the no-identity case); the route keeping marked entries (the route case and the full-chain case); the walk dropping an entry, and the walk keeping hidden directories (both child-level listing assertions). From a scratch clone placed beside 400 directories, the file as on `main` spent 12.7 s and 13.5 s in the two child-level cases and returned early from the third at its 4.75 s budget; as built, the same cases took 0.07 s, 0.001 s and 1.2 s. The junit reports of each are kept in the lane's evidence directory and their numbers are in the PR.

**Not covered.** Whether any test that starts a whole server without naming `projectsDir` reads the default `~/Projects` was not audited. The search for other tests reading the checkout's parent, or walking with a budget of ten seconds or more, found only this file.

## 2026-10-10 — #2288: the README opens with the problem, the product, and what it is not

<!-- prawduct: type=docs | scope=2288-readme-opening -->
#2288 Chunk 01, the issue's only chunk. Branch `docs/2288-readme-opening`, from `origin/main` `8cbaf34b`. Documentation only.

Visual change: no

**Why.** A visitor decides in seconds. The old opening spent them on a category and a promise nobody could check ("a fundamentally new way to build software"), and said neither what goes wrong without TangleClaw nor what the visitor would see after installing it. The Operator approved a replacement text, with its headline and subtitle, in the issue.

**What changed.** `README.md` only:
- From the tagline to the line before "Core Features", the file is now the issue's approved text: the headline "Many Agents. One Claw.", the problem, "What you get", the engines sentence, "What it is not", "Built with itself" and "Try it". The logo block and the badge block keep their bytes. The engine chips line, the centred macOS line, the `## Overview` heading, the two rules, the note naming a gallery version and the empty `## Screenshots` heading are gone; the macOS fact is carried by "What it is not".
- The demo line is an HTML comment until the Operator supplies a recording, and nothing renders in its place.
- "SDLC Departments & Agent Roles" moved, whole, to after "Core Features" and before "Quick Start". It gained one paragraph saying which roles exist today, and its Builder bullet lost the word "autonomously", which contradicted the section's own last paragraph.
- "Core Features" and everything from "Quick Start" to the end of the file are byte-identical to before.

**Decisions.**
- [DECISION: the Node bullet reads "written against Node.js 22's standard library: no `npm install`, no bundler", not the approved "Node.js 22 and nothing else: no `npm install`, no build step". | Ruled `2288 node narrowed` and then `2288 build narrowed` by TangleClaw-Builder1, which drafted the text: the installer also puts ttyd, tmux, mkcert and Caddy on the machine, and it builds ttyd from pinned source, so both halves of the approved sentence were true of the server only. "A false claim does not ship because it was approved".]
- [DECISION: the sentence linking a screenshots gallery is removed. | Ruled `2288 screenshots drop`: the address answered 404 when read. The README linked the same dead address before this change; publishing a gallery is the Operator's.]
- [DECISION: the roles paragraph says the Project Master is the one role that ships as a product feature and that no role template can be selected yet. | Written from the code and checked against it by TangleClaw-Builder1: no role or template file, setting or screen exists. The coordinator roles the Operator can grant over the API govern only a context rotation and are left out, because a visitor cannot use them. The merge waited for the Operator's yes on this paragraph.]
- [DECISION: no test is added. | No behaviour changes, and a test pinning marketing copy would fail every later edit of it. The install command's tag stays held to `version.json` by the existing pin test.]

**Checked.** Every claim in the new text was read against a line of "Core Features" or the code, one row each in the PR. Two failed and were ruled as above. One holds with a limit the PR states: a rule reaches every session of its project at launch and after a clear, and a session already running gets a later rule at its next one. The unchanged ranges were compared by sha256, not by eye.

**Left for a later documentation fix, outside this chunk's range.** "Core Features" still says "No npm install, no build step, no bundler" under "Zero dependencies": the same inaccuracy this chunk removed from the opening. `CONTRIBUTING.md`, the vision line of `CLAUDE.md` and the website still carry the old tagline.

## 2026-10-10 — #2282: the contributing guide says who can open a pull request

<!-- prawduct: type=docs | scope=2282-contributing-outside-prs -->
#2282 Chunk 01, the issue's only chunk. Branch `docs/2282-contributing-outside-prs`, from `origin/main` `4493b7fe`. Documentation only.

Visual change: no

**Why.** The repository's setting accepts pull requests from collaborators only (`pull_request_creation_policy: collaborators_only`, read from the GitHub API on 2026-10-11 UTC). `CONTRIBUTING.md` told every reader that pull requests were still welcome and ended "Making Changes" with "Submit a pull request", so a reader who is not a collaborator learned the route did not exist only after doing the work.

**What changed.** `CONTRIBUTING.md`, three sections and two sentences outside them:
- "Issues Are Preferred Over Pull Requests": the "still welcome … if you send one" paragraph is replaced. The section now says pull requests can be opened by collaborators only, that a fix is offered by describing it in an issue, that a fork branch or code in an issue comment is not picked up because outside code is never merged, fetched or run here, and that what helps is a reproducible report. The two pieces of advice that followed are kept: the first is addressed to collaborators, the second to everyone.
- "Making Changes": one sentence in front of the steps says they are for collaborators and points everyone else to the section above. The steps are unchanged.
- The introduction no longer says the guide covers how to "submit changes": it says "report a problem or offer a fix", and who can open a pull request. The first paragraph of "Areas Looking for Contributions" told every reader to propose an approach "before starting"; that is now addressed to collaborators, and everyone else is told the help that arrives is an issue. Both would have contradicted the corrected sections; allowed by the Integrator as `2282 two more sentences`.
- "Security & Contribution Guidelines": one paragraph after the opening says a pull request in the points is a collaborator's and that points 2 and 3 hold for a fix described in an issue. Point 2 gains a sentence carrying the credit to that route. Point 3 says "contribution, whether a collaborator's pull request or an issue" where it said "pull request". The points keep their numbers, which `docs/adr/0014-dual-key-review-for-untrusted-prs.md` and `docs/dependency-bump-audit.md` cite.

**Decisions.**
- [DECISION: the promise of credit stays, for a report that leads to a fix. | Ruled `2282 credit stays` by TangleClaw-Builder1 on the Operator's instruction: "for a report that leads to a fix. It matches ADR 0014's credit rule."]
- [DECISION: no rule in "Security & Contribution Guidelines" changes, and ADR 0014 is not edited. | The issue asks that the section still read correctly, not that the policy move.]
- [DECISION: the guide says outside code is never "merged, fetched or run", not that it is never read. | Those are the repository owner's words on the issue; the section itself says a pull request is audited as a text diff.]
- [DECISION: no test is added. | No behaviour changes and no test reads this file.]

**Checked.** Every section anchor the new text links to resolves to a heading in the file. Every remaining mention of a pull request in `CONTRIBUTING.md` is CI's, a collaborator's, or the audit's; the PR lists them. A search of every tracked file found no other invitation to an outside pull request.
## 2026-10-10 — #2272: the Discord helper gives up a Gateway connection attempt that goes nowhere

<!-- prawduct: type=bugfix | scope=bridge-2272 -->
#2272 Chunk 01 of five. Branch `fix/2272-gateway-stuck-attempt`, from `origin/main` `907ef3d0`.

Visual change: no

**Why.** Twice on 2026-10-10 the operator bridge's Discord helper logged a Gateway close with code 1006, one `gateway-connecting`, and then nothing: for twelve hours the first time and three the second it posted notices and received no reply, until it was restarted by hand. `lib/bridge-helper/discord-gateway.js` scheduled a reconnect only from a socket's `close`, and its `error` handler did nothing, on the stated belief that a close always follows an error.

**The reproduction, before the fix.** `origin/main`'s module, run over Node 22.22.3's own WebSocket for 400 seconds against six kinds of address. In every one the module logged `gateway-connecting` once, stayed in `connecting`, and held no timer at the end:
- the connection is refused, or the host name does not resolve: Node fires `error` within 50 ms and **no `close`, ever**;
- the address never answers the connection (a reserved test address): `error` after 10.5 s, no `close`;
- a server accepts the connection and never answers: `error` after 302 s, no `close`;
- a server completes the WebSocket handshake and never sends HELLO: `open`, then no event at all;
- the address lookup never settles (with the fake): no socket is ever made. In the helper as shipped this one is bounded already, since the lookup is a REST call with a 15-second limit.
So the belief was false for every connection that fails before it opens, which is what a reconnect one second after a 1006 close meets when the network is still down. That fits both nights' logs. It is not proved to be what happened: the helper logged nothing that could tell these cases apart.

**What changed.**
- `lib/bridge-helper/discord-gateway.js`: an `error` on a socket that has delivered no frame ends the attempt and schedules the next (`gateway-connect-failed`); an `error` on one that has is still left to its close, whose code decides. Every attempt has a limit, 30 seconds from `connect()` to READY or RESUMED (`attemptTimeoutMs`); past it the attempt is given up (`gateway-attempt-abandoned`, with `reached`: `lookup`, `socket`, `open` or `hello`), the socket is detached and closed with the code that keeps the session, and the shared backoff schedules the next. A watchdog on its own interval, 60 seconds (`watchdogMs`), starts an attempt when there is no socket, no attempt in flight and no reconnect waiting (`gateway-watchdog-reconnect`); it runs from `start()` to a stop or a fatal close. An address lookup that answers after its attempt was given up opens nothing. `status()` gains `since`, the time the current state began.
- `lib/bridge-helper/log.js`: the three codes.
- `docs/operator-bridge-helper.md`: a section on an attempt that goes nowhere, the three codes in the troubleshooting table, that the helper must be restarted after an update, and what is not proved against Discord.

**Decisions.**
- [DECISION: a failed connection is retried from its `error`, not only at the 30-second limit. | The plan had the limit and the watchdog; the reproduction showed the common failure is immediate and silent. Waiting out the limit each time would be correct and slow. | Told apart from an error on a live connection by whether the socket ever delivered a frame: Discord sends a fatal close code only after HELLO, so no such code can be lost.]
- [DECISION: how far an attempt got is logged on the line that gives it up, not by a new code each time a socket opens. | The plan asked for a code when a socket opens "so the next log can tell the cases apart". `reached` tells them apart in one line, adds nothing to the log of a healthy reconnect, and needs no `open` listener, which the shared test WebSocket (`test/_fake-discord.js`, not edited) does not have.]
- [DECISION: the limit and the watchdog cannot be switched off. | An option to disable them would be an option to bring the defect back.]
- [DECISION: both new timers are `unref`'d. | They watch the helper's loop and must never be what keeps its process alive; `stop()` clears them as well.]
- [DECISION: the watchdog's check is "no socket, no attempt, no reconnect", whatever the state says. | A gateway that says `ready` and holds no socket is as dead as one that says `connecting`.]

**Tests.** `test/bridge-helper-gateway.test.js`. With the fake WebSocket and hand-run timers: each of the four ways an attempt stalls is given up at the limit with its `reached`, the socket closed with 4000, a reconnect on the backoff, and a new socket; the abandoned socket's later frames, error and fatal close change nothing; a failed connection is retried from its error and a close that follows is not counted twice; an error on a connection that was open is left to its close; nine attempts in a row back off 750 ms to 45 s and a READY starts the count again; a session is still resumed, same id and sequence, after an attempt was given up; an attempt that ends by a close, a refused session or a constructor that throws takes its limit with it; the watchdog starts an attempt from a state with no socket and no timer (made by a log sink that throws once inside the close handler), and does nothing while ready, while an attempt is in flight with or without a socket, or while a reconnect waits; it is gone after a fatal close, stays gone through a stop and start, and after a stop; a stop leaves no timer in five phases; a lookup that answers after a stop opens nothing; `since`. Over Node's real WebSocket and real timers, with limits no busy machine can miss: a server that accepts and never answers is given up twice at 150 ms; one that upgrades and never says hello is given up at one second as `open` and a second attempt starts; a refused port fails twice from its error, well inside a five-second limit. Every code logged on these paths is held to the helper's registry through the real logger. Run against `origin/main`'s module in a scratch copy, every case of an attempt that stalls or fails, of the watchdog starting one, and of `since` fails; the cases that guard what the fix must not disturb (an error on an open connection, no limit left behind, no timer after a fatal close) pass there too. Each clause of the fix was changed or removed in turn in a scratch copy and watched red; the clauses no test could reach were removed instead of kept.

**Two existing assertions changed, and why.** "the first heartbeat is jittered inside the interval" and "on the reconnect backoff, with the heartbeat stopped" each compared the whole list of waiting timers, which now also holds the watchdog and, during an attempt, its limit. Both still compare the whole list, with the new timers named in it; neither is loosened. The plan's criterion 7 said every existing case would pass unchanged; these two could not.

**Not built here.** Nothing shows the outage or raises a notice (Chunks 02 to 05). `since` restarts each time the state moves between `connecting` and `reconnecting`, so it is not yet "down since": Chunk 02 needs the time the gateway last stopped being ready. Messages sent to the bot while the Gateway was down are still not replayed. Not proved against Discord, which cannot be made to stall on demand. The live helper runs the old code until it is restarted after the deploy.

## 2026-10-10 — #2284: the setup wizard no longer calls every server notice a skipped item

<!-- prawduct: type=fix | scope=2284-setup-wizard-warning-wording -->
#2284 Chunk 01, the issue's only chunk. Branch `fix/2284-setup-wizard-notice-wording`, from `origin/main` `dac01887`.

Visual change: yes

**Why.** When `POST /api/setup/complete` answers notices, the wizard's confirm step wrote "Setup finished, but N item(s) were skipped:" in front of them. Only two of the route's notices are skipped items. The others say the Master's launch mode was reset, a project failed to attach, the ingress was left alone, or a login was saved without being enforced, so an operator whose launch mode had just been reset was told an item had been skipped and nothing else.

**What changed.**
- `public/setup.js`: new `_noticesSentence(warnings)` words the sentence, and the confirm step writes what it returns into `#setupCompleteError`. The sentence is "Setup finished. One thing to know: …" for one notice and "Setup finished. N things to know: …" for more, with the notices joined as before. The comment above the call no longer says the list is what the server skipped.
- New `test/setup-wizard-notice-wording.test.js`.

**Decisions.**
- [DECISION: the heading stops claiming a kind; the server does not label kinds. | Ruled `2284 heading` by TangleClaw-Builder1 on the Operator's instruction: "A wording fix; no change to the route's answer." `server.js` is not touched.]
- [DECISION: the function counts only non-empty strings, as `_warningsBlock` does for the same list on the later screens. | The count then equals the number of notices shown; the old sentence counted every entry and joined whatever was there.]
- [DECISION: `public/sw.js` is not changed. | `setup.js` is a network-first path, and `scripts/cache-bump-guard.js --base origin/main` answers "No cache-first asset changed in this diff".]
- [DECISION: `docs/user-guide.md` is not changed. | It does not quote the old sentence.]
- [DECISION: no browser run, on a scratch server or on the live install. | Ruled `2284 tests only`: "Nobody re-runs setup on the live install for a screenshot." The Integrator's release adds that no scratch server is started on this host. The tests drive the wizard's real submit function and read the element it writes; the queue entry is accepted on that reason, not verified.]

**Tests.** Each drives `wizardComplete` from `public/setup.js` against a stubbed response and reads `#setupCompleteError`. A reset notice alone is shown, in the singular, with no "skipped" anywhere. A skipped project still says so in its own words under a heading that does not. A reset and a skipped item together count 2 and keep the server's order. An already-registered project, a failed attach, an ingress reason and the saved-credential notice are none of them headed as skipped. An empty list, a missing one, a string, an array-like object and a list of non-strings write nothing and leave the element hidden. The count is of the notices shown. A notice carrying markup arrives as characters. The old sentence and the old comment are gone from the file. The later screens' "Also worth knowing:" block renders as before. Four deliberate breaks (the heading saying "skipped", `innerHTML` for `textContent`, the filter removed, the singular removed) each failed cases and were restored byte-identical.

**Not seen in a browser.** The confirm step with a notice on it, at any width; the sentence's wrapping at 375 and 320 pixels.

## 2026-10-10 — #2273: every rule change rewrites what a cleared session is re-delivered

<!-- prawduct: type=bugfix | scope=rules-2273 -->
#2273 Chunk 02 of two, the plan's last. Branch `fix/2273-rules-refresh-routes`, from `origin/main` `944c95d1`.

Visual change: no

**Why.** Chunk 01 built the module that regenerates a project's rules files and left it uncalled. The session-start hook prints those files on every start, including after a `/clear` and a compaction, so until a rule change rewrites them a cleared session is re-delivered the launch-time set as binding: a rule approved mid-session missing, a retired one still stated.

**What changed.**
- `server.js`: one helper, `refreshDeliveredRules(before, after)`, beside `sessionRuleCaller`, and one call to it in each of the six routes that can change the rules in force (`POST /api/session-rules`, `PUT /api/session-rules/:id`, `DELETE /api/session-rules/:id`, `POST /api/session-rules/promote`, `PUT /api/session-rules/:id/status`, `POST /api/session-rules/:id/restore`), after the store write and before the answer. It rewrites the project's files when the rule entered or left the set in force (kind `startup`, status `active`, enabled), or became or stopped being an active rule: an approval retires the rule it replaces in the same write, whatever the approved rule's own switch says. A proposal, a wrap rule, a Project Master rule and a text edit or rollback of an active rule (which the store files as a proposal) rewrite nothing. An approval that retires the rule it replaces is one rewrite, after both.
- The rule change never fails because of the files. When they do not follow it, the success response carries `deliveryWarning` and the log says the same: either the files could not be rewritten (the cause, and whether the set on disk is the old one or part new and part old), or the project's running session has no rules file or no hook registered to print one.
- `lib/session-rules-refresh.js`: every `nothing-to-refresh` verdict carries `rulesInForce`, the count of rules in force for the project. That is what lets the route tell "no rule governs this project" from "rules do and no file states them".
- `docs/session-rules-self-improvement.md`: a section on a rule change and the running session.

**Decisions.**
- [DECISION: a project launched with no rule in force is TOLD its first rule is undelivered; it is not delivered. | Ruling 14, TangleClaw-Builder1, 2026-10-10 21:34 PDT, on the Operator's word in the Integrator's pane at 20:32 PDT ("Follow the builder's recommendations. Get rulings on any ones that it didn't rule on, and follow them."): 'first rule says and file'. "An undelivered rule must be stated, never silent." | Such a project has no rules file and no rules hook, and ruling 7 forbids registering a hook mid-session until that is shown with the real engine. The response and the log say the rule is in force, that the running session will not be re-delivered it after a clear or a compaction until its next launch, and that `tc rules` shows it meanwhile. Delivering it is #2293.]
- [DECISION: that warning is given only while a session of the project is running. | With none running nothing is undelivered: the next launch writes the files. The ruling's words are "a project whose running session has no rules file and no rules hook".]
- [DECISION: the files are rewritten only when the rule entered or left the set in force or changed whether it is an active rule, not on every call. | A rewrite restates the time the block was written; a proposal or a pending text edit rewriting it would change files for a change that is not in force (the plan's criterion 6), and would raise the undelivered warning for it. | It relies on the store filing every text change of an active project rule as a proposal (#1696), so text in force changes only by a rule entering the set.]
- [DECISION: the warning is a field on the success response, `deliveryWarning`, and no screen shows it yet. | The plan allows no screen change in this chunk. The dashboard ignores the field; a caller of the API and the server log carry it.]
- [DECISION: the helper catches whatever its own reporting throws and answers the route as a success. | The rule change is already saved (the plan's R3).]

**Tests.** `test/api-session-rules.test.js`, against the real server, a real store and real project directories with launch-shaped files and registered hooks: for each of the six routes, the files afterwards hold exactly the rules `GET /api/session-rules` reports in force; switching a rule off and on; deleting the last rule leaves the first file with its heading; a learning promoted into a startup rule is in the files and into a wrap rule leaves their bytes alone; retiring; a text edit leaves the bytes alone and its approval leaves the new text and not the old; approving a replacement that was switched off first still takes the rule it retires out of the files (found by the review: the first build decided from the approved rule alone and rewrote nothing); declining a proposal, a bound session's proposal, its revision and its withdrawal leave the bytes alone; a rollback that switches a rule back on, and one that changes text (filed as a proposal); the real hook script run after two route calls prints the rules in force; a Project Master rule. With the registered hooks unreadable, each of the six routes still answers its success status, the change is in the store, the response warns and names the file at fault, the log names the project and the cause, and the files are unchanged; a swap that fails part-way is said to be part new and part old. Where the launch wrote no file: nothing is written; no warning with no session running; with one running, the warning and the log line, the count growing with a second rule, none for a proposal or once no rule is left; files with no hook registered are named as that. `test/session-rules-refresh.test.js`: the count on the verdict (none, two with a wrap rule beside them, one after a rule is switched off, no project), and the two existing whole-verdict assertions now include it. Each call site removed in turn in a scratch copy, and the helper's conditions inverted, each watched red.

**Not built here.** The first rule of a project launched with none is not delivered to its running session (#2293). No screen shows `deliveryWarning`. A rule changed by a writer other than these six routes (none puts a project rule in force today: the wrap's proposal step files proposals, and `lib/master.js` writes kind `master`) would not rewrite the files. Nothing is rewritten for a session whose launch delivered its rules another way (an engine with no second channel, silent prime off, a bare launch): a rule change that moves the set in force while such a session runs gets the same warning, which is true of it, and `tc rules` is how it re-reads them. The launch's `writeShards` still writes each file in place (a follow-up, to be done alone as launch-path work).
## 2026-10-10 — #1796: the tracked `CLAUDE.md` block is held to what the generator writes

<!-- prawduct: type=chore | scope=1796-claude-md-block-parity -->
#1796 Chunk 01, the issue's only chunk. Branch `chore/1796-claude-md-block-parity`, from `origin/main` `88d8e5f5`.

Visual change: no

**Why.** The region between the `BEGIN:tangleclaw` and `END:tangleclaw` markers of this repository's `CLAUDE.md` is generated: a launch of any session in a checkout splices it. The generator's output had moved twice (a switchboard row about launch headers, and the PortHub guide's "Identify Your Session" section) and the tracked file had not, so every launched checkout carried the same twelve uncommitted lines, every merge that touched the file was refused until they were set aside, and no test said the two had parted.

**What changed.**
- `CLAUDE.md`: the twelve lines, inside the markers and nowhere else. They are the server's own rewrite, committed after the production renderer and splice were shown to leave the working copy byte-identical on `88d8e5f5`; nothing between the markers was typed by hand.
- New `scripts/sync-claude-md-block.js`: with no argument it compares the tracked block with the generated one, writes nothing and exits 1 on a difference; with `--write` it replaces only the marked region, atomically, and refuses a file that does not hold exactly one marker pair in order. `--file <path>` points it at another copy.
- New `test/claude-md-operational-block.test.js`: reads the tracked file and holds it to the generator. It never writes the file.
- `docs/engine-guide.md`: one paragraph on the rule this creates and the profile the block stands for.

**Decisions.**
- [DECISION: the block is rendered for one named profile, pinned in the script: switchboard on, PortHub guide on, the install's service-token gate off, no shared document injectable for the project. | Ruled `1796 pin` by TangleClaw-Builder1 on the Operator's instruction: every clone launched so far has those settings, and making the generator ignore them would change what every managed project is told. A checkout with other settings still shows a difference, and the guide says so.]
- [DECISION: a script exists and the failing test names it. | Ruled `1796 script`, "Writes only with --write". A contributor reading a CI failure has something to run without running TangleClaw on the checkout.]
- [DECISION: the script and the test share one comparison, exported from the script, and it goes through `engines._mergeManagedBlock`. | "In sync" then means exactly "a launch would leave this file byte-identical", including the splice's own trimming, and the two cannot disagree about it.]
- [DECISION: the rendering runs on a scratch store that the script writes and removes, and the store's base path is put back. | The host's token gate must not reach the expected bytes; CI has no host config at all.]
- [DECISION: `lib/engines.js` is not changed, though the plan allowed its exports list. | The plan read `_managedBlockMarkers` as not exported; on `88d8e5f5` it is, as `managedBlockMarkers` and under its own name.]
- [DECISION: the failure message shows a window around the first differing character, not the start of the line. | The verb line runs to several hundred characters and differs by one word; the first draft clipped the line and showed two identical halves.]

**Tests.** One begin and one end marker, in order. The block between the markers equals the generated block as the splice leaves it. Splicing the generated block into the tracked text returns the tracked text. Git classifies the file as committed, and rendering with this checkout as the project path gives the same bytes as the pinned rendering. The block carries no loopback origin. A token gate switched on in the store in use adds nothing to the pinned rendering, and the store is handed back where it was. Every verb `tc-verbs.js#verbsFor('pane')` yields is in the tracked block, read from the roster and not listed in the test. A verb pushed onto `VERB_ROSTER` in memory fails the comparison and the message names the sync command and shows the new verb. A changed expected block fails it too. Four malformed files (no markers, no end, a second begin, the pair inverted) are refused with nothing to write. The script, run as a child process on copies in a temporary directory: exit 0 on a match, exit 1 on a drifted copy with the command named and the copy untouched, `--write` restores the copy to the tracked bytes with text outside the markers unchanged and a second run finding nothing to do, `--write` on broken markers leaves the file as it was, exit 2 on an unknown argument and 1 on an unreadable file. Last, the tracked file has the same bytes, size and modification time as before the tests ran. The script is never run with `--write` on the repository's own file. Three deliberate changes to the generator's inputs were each run against the new file and then restored from a copy (sha256 equal before and after): one word added to `data/porthub-guide.md`, a guidance line reworded in `lib/ecosystem-primer.js`, and a verb added to `VERB_ROSTER` in `lib/tc-verbs.js`. Each turned the comparison cases red, and the script's message named the line and the command.

**Not built here.** The generator and what it emits are unchanged. Text outside the markers is neither asserted nor changed. Whether a real launch of the installed server leaves the live checkout clean can only be read after the deploy and is the Integrator's check.

## 2026-10-10 — #2273: a project's delivered rules files can be regenerated from the rules in force

<!-- prawduct: type=bugfix | scope=rules-2273 -->
#2273 Chunk 01 of two. Branch `fix/2273-rules-refresh-module`, from `origin/main` `6ff03b78`. Nothing calls the new module yet, so a running install behaves as before; Chunk 02 calls it from the routes that change a rule.

Visual change: no

**Why.** The launch writes `.tangleclaw/session-rules-<n>.json` once, and the session-start hook prints those files on every start, including after a `/clear` and a compaction. A rule approved, edited, disabled or retired while the session runs changes the store and not the files, so a cleared session is re-delivered the launch-time set as binding: new rules missing, retired ones still stated. Nothing was ever built to rewrite the files after launch.

**What changed.**
- New `lib/session-rules-refresh.js`. `refreshProjectRules(projectId)` reads the project's active startup rules from the store, renders them, and replaces the project's rules files. It returns a verdict and never throws: `refreshed` (with the rule count, the files written, the files removed and the ids of any rule it could only name), `nothing-to-refresh` (no project, no rules files on disk, or files with no rules hook registered to print them) or `failed` (with the cause). It writes one file per rules hook registered in the project's `.claude/settings.local.json`, which it reads and never writes. Each file is written beside its target and renamed over it, and no target is replaced until every file of the set is on disk, so a hook firing mid-refresh prints a whole old file or a whole new one and a refresh that cannot stage its files leaves the old set. A swap that fails part-way is said as such: the `failed` verdict carries `filesReplaced`, and the log line says the set on disk is part new and part old. The budget is that of the engine the project's live session runs, resolved as the launch resolves it, and of the stored engine only when nothing is running: a session started on another engine than the project stores is held to the cap of the engine that prints the file.
- `lib/session-rules-channel.js`, two additions the launch does not call. `packFixedSlots` packs a rule set into a fixed number of slots: it never returns more slots than it was given, keeps every payload within the budget measured on the finished JSON, and puts in the last slot one line that gives the count of rules in force, names each rule it could not carry by id (a list of names long enough to break the budget by itself is cut to "and N more") and points to `tc rules`. `renderNoRulesText` is the block for a project with no rule left in force. Every rewritten block states the count in force, the time it was written, and that it is the current statement where a count elsewhere in the session differs. `buildShards`, `renderShardText`, `writeShards` and every other function the launch calls are unedited.

**Decisions.**
- [DECISION: a refresh writes as many files as there are rules hooks REGISTERED for the project, read from `.claude/settings.local.json` as slots 1..n with no gap. | Ruled by TangleClaw-Builder1 at 2026-10-10 20:30 PDT, on the Operator's instruction to the Integrator at 20:27 ("Please direct these questions to Builder One for a ruling."), replacing its ruling of 15:54: "Every file must have a hook that will read it; a file with no hook is a rule in force and not delivered. With 2 files and 3 hooks, write 3. If files ever exceed hooks, the limit is still the hooks." | The count is one function, `registeredSlots`.]
- [DECISION: the refresh registers no hook. | The same ruling: "Do not register a new hook mid-session on the strength of the engine's reference alone: that it is picked up mid-session must be shown with the real engine before the design relies on it." A rule set that outgrew the registered hooks is named in the last file.]
- [DECISION: whether to refresh at all is still decided by the files, not the hooks: no first file, nothing written. | A launch that declined rules delivery removes its files, and the hook sync can register hooks for a project whose launch delivered nothing. A launch with NO RULE in force also leaves no file, and the verdict does not tell the two apart: see "Not built here".]
- [DECISION: files on disk with no rules hook registered are left as they are and the verdict says `no-rules-hooks`; a settings file that cannot be parsed is a `failed` refresh. | Nothing prints a file with no hook, so rewriting it delivers nothing; and an unknown number of readers is not zero readers.]
- [DECISION: a rule too large for a slot of its own is named, not printed. | The launch prints it whole and lets the engine clip it; the engine clips by replacing the whole payload with a preview, which loses every other rule in that file too. The plan's criterion is that no file exceeds the budget. | The launch's own behaviour is unchanged.]
- [DECISION: sizes are measured on the finished payload, not estimated from the text. | Quotes, backslashes and newlines double inside the JSON envelope, and the launch's fixed 320-character reserve does not count them. A rewritten block has a longer header than the launch's, so the reserve would not have been right for it anyway.]
- [DECISION: with no rule in force the first file stays and says so; further files are removed. | The ruling of 15:54 PDT: the prime tells a session that a missing "Project Rules" block means delivery failed.]
- [DECISION: no delivery-ledger row for a refresh; a log line records it. | The ledger vouches for a launch's delivery and its receipt. The receipt token is not touched either.]
- [DECISION: files a shrunken rule set no longer needs are removed, as the launch removes them, and so is a file beyond the registered hooks. | A file left behind is a live hook printing rules that are no longer in force. A set that later grows again is given files again, up to the registered hooks.]

**Found while building (both of the plan's engine assumptions).**
- The plan assumed Claude Code fixes a session's hook list at session start. Its hooks reference, read 2026-10-10 at `code.claude.com/docs/en/hooks`, says: "Direct edits to hooks in settings files are normally picked up automatically by the file watcher." The same page confirms the cap the budget stands for: `additionalContext` is capped at 10,000 characters, and over it the output is replaced by a file path and a preview.
- The plan assumed the files on disk equal the rules hooks registered. Observed in the lane's own clone, untraced: two rules files written at its launch (2026-10-09 15:25 PDT) and three rules hooks in `.claude/settings.local.json`, rewritten 2026-10-10 14:14 PDT, mid-session, by something not identified.
- What followed: both facts went to the Integrator, the question to TangleClaw-Builder1 on the Operator's instruction, and the ruling above came back. In that clone the first ruling would have printed three of five rules in force and named two; the registered hooks carry all five. What registers a hook mid-session there is still not traced.

**Tests.** New `test/session-rules-refresh.test.js`, against a real store in a temporary home and real project directories: the plan's case of a kept, an edited (through the proposal and its approval) and a new rule with a retired one gone; the count, time and current-statement line; no files, nothing written; no project; no rule left, first file kept and the second removed; a set that outgrew one file, and one that outgrew two, each printed-or-named per rule and within the budget; two files and three registered hooks, three files written; two files and one hook, one file written and the other removed; files with no rules hook, and with no settings file, nothing written; a settings file that is not JSON, a `failed` verdict whose cause names that file, and the old file unchanged; the hook count as 1..n with no gap, ignoring the prime hook, an operator's hook and another event; the count read from what the real `syncEngineHooks` writes; a refresh that cannot write (a directory where the staging file belongs, which refuses whatever the process's privileges) returns `failed`, throws nothing and leaves the old file byte-identical; a later file that cannot be staged leaves the earlier one unreplaced; a swap refused on the second file reports one file replaced; a project stored under an engine with a larger budget is sized for Claude's cap once a session on Claude is live; no staging file left behind and a second refresh identical; the receipt token untouched; and the real hook script, run with `{"source":"clear"}` on stdin, prints the refreshed block. `test/session-rules-channel.test.js` gains the cases for the two additions; its existing cases are unchanged and pass.

**Not built here.** Nothing calls the refresh (Chunk 02). A project launched with no rule in force has no rules file and no rules hook, so the first rule approved for it mid-session is `nothing-to-refresh` (`no-rules-files`) and a cleared session still gets no Project Rules block until the next launch: delivering it needs a hook registered mid-session, which the ruling above forbids until shown with the real engine. Chunk 02 is to make that verdict carry the count of rules in force so the route can say so; today the verdict reads the same as a launch that declined delivery. No hook is registered when a rule set outgrows the registered ones: that waits on showing, with the real engine, that a hook added mid-session fires. The launch's `writeShards` still writes each file in place, so a hook firing during a launch's write can print half a file: decided out of this plan by the Integrator (2026-10-10 15:49 PDT) as launch-path work to be done alone. The prime's and the re-entry text's own rule count is still the launch's. Engines other than Claude, Master rules and wrap rules are not covered. A real Claude Code session re-reading the block after a real `/clear` is not proved by any test here: that is the check after the deploy.
## 2026-10-10 — #2286: a direct test holds every answer of `_operatorProofOf`

<!-- prawduct: type=bugfix | scope=2286-operator-proof-direct-test -->
#2286 Chunk 01, the issue's only chunk. Branch `fix/2286-operator-proof-direct-test`, from `origin/main` `6ff03b78`.

Visual change: no

**Why.** `server.js#_operatorProofOf` answers `operator-verified` only for a gate that is `armed`, a session, and that session's CSRF token on the request. The `armed` condition could be deleted with every test still passing (seen by deleting it on purpose while building #2244): wherever the login gate stands down the request handler resolves no session, so no request reaches the helper with a session and a gate that is not armed. The word a recovery clear and a recovery-mode decision are recorded with rested on a condition nothing held.

**What changed.**
- `server.js`: `_operatorProofOf` is added to `module.exports`. That line is the whole change to the file; the function body and every route are as they were.
- New `test/operator-proof.test.js`: calls the helper with request objects built by hand, carrying the three things it reads (`tcGateState`, `tcSession`, the CSRF header).

**Decisions.**
- [DECISION: the helper is exported from `server.js` and not moved to a module of its own. | The issue asks for the smallest thing that closes the gap; moving it is a larger diff in an authorization path for no gain here.]
- [DECISION: the gate states the test walks are read from `auth-gate.js#GATE_STATES`. | A state added later is exercised without editing the test, and it must answer the unverified word to pass.]

**Tests.** The proven case answers `operator-verified` and names the session's user. Every gate state other than `armed`, and a made-up word, `undefined` and `null`, each with a session and its valid token, answer `open-install-unverified` with no actor. An armed gate with no session answers unverified. An armed gate and a session answer unverified with no CSRF header, an empty one, a wrong token of another length, a wrong token of the right length, the right token under another header name, and a session that holds no token. Every case also asserts the answer has exactly the keys `clearance` and `actor`. Three deliberate breaks were each run and the file restored from a copy (byte-identical after): the `armed` condition removed fails the per-state and unknown-state cases; the session condition removed fails the no-session cases; the CSRF comparison removed fails the token cases. No existing test changed.

**Not built here.** What the helper answers, who is admitted in any gate state, and how a session is resolved while the gate stands down are unchanged and were not in question.

## 2026-10-10 — #2197: the setup route applies the launch-mode rule, and the status payload says which engine is set

<!-- prawduct: type=bugfix | scope=master-2197 -->
#2197 Chunk 03 of three, the issue's last. Branch `fix/2197-setup-route-engine-mode`, from `origin/main` `a4246d2e`.

Visual change: yes

**Why.** Two things the first two chunks left open, both written down in them as not built. `POST /api/setup/complete` wrote `defaultEngine` from the request without the rule that `PATCH /api/config` applies, so a Master that follows the default engine kept a launch mode chosen for the previous one: the issue's own defect by another door. And `GET /api/master/status` did not say which engine is SET for the Master. With no pin the settings modal worked it out from the page's copy of the config, else from the engine the server resolved, and either can be wrong (a copy loaded before the default engine changed; an installed engine standing in for a missing one). Chunk 02 made a wrong reading harmless by sending nothing on the strength of it, and the modal could still list the wrong engine's modes and call a validly stored mode foreign.

**What changed.**
- `server.js`, the `POST /api/setup/complete` handler: when the request sets `defaultEngine`, the Master's launch mode is judged by `master.masterLaunchModeAfterPatch` over the configured engine before and after, as the `PATCH /api/config` handler does. A mode chosen for another engine than the one the default becomes returns to `default`; the reset is said in the response's `warnings` (the array the route already answers) with `masterLaunchModeResetWarning`, and logged at info once the config is saved. The route sends no launch mode, so it can only keep or reset one.
- `lib/master.js#getMasterStatus`: `settings.configuredEngine`, the engine set for the Master (its pin, else the default engine, `null` when neither is set), passed on from `_masterRuntime`, which already answered it.
- `public/api-helper.js#tcMasterLaunchModeView`: the stored engine is `settings.configuredEngine` when the payload has the key. The untouched control beside a foreign mode is then sent on the server's word for which engine is set (the stated engine or a pin), and still only while the dropdown shows the stored pin. A stated `null` means no engine is set: the engine compared is then the one the server resolved, since that is where the server runs a mode recorded for it, and nothing is sent untouched. A payload without the key is read as before and nothing is sent on that reading.
- `lib/master.js#ensureMasterSession`: the launch warn line for a mode that is not honored said "Choose a launch mode for this engine"; during a substitution that names the stand-in, and a mode is chosen for the engine that is set. It now says "the engine set for the Master" and carries `configuredEngine`. Carried from Chunk 01's review for the next commit to touch this file.
- `docs/configuration-reference.md`: the `master.launchModeEngine` row names `configuredEngine` beside `resolvedEngine`; the `/api/setup/complete` row says a `defaultEngine` sent there is judged like one sent to `PATCH /api/config`.

**What the operator sees differently in the modal.** No new sentence. Two existing ones appear where they did not: on a Master with no pin whose stored mode belongs to another engine, the note now ends "Saving this form stores the mode selected here for <engine> in its place." where it said "Choose a mode here to replace it."; and on a Master with no pin whose default engine is not installed, the modal now shows the stored mode as selected, lists the modes of the engine that is set and says which engine is standing in, where a page without the config called the mode foreign.

**Decisions.**
- [DECISION: the setup route's reset is reported in the route's existing `warnings` array, with no new field. | The array is already the route's complete list of what the caller must be told, and the first-run wizard already renders it. | Within the plan's "says it in the route's response".]
- [DECISION: `public/setup.js` is not changed. | It is not on this chunk's list. The wizard prints every warning under "Setup finished, but N item(s) were skipped:", which misdescribes a reset. Reported to the Integrator with this chunk; see "Not built here".]
- [DECISION: the rule runs only when the request sets `defaultEngine`. | A request that does not name it cannot change the Master's engine, and rewriting the stored Master block on an unrelated re-POST would be a write nobody asked for. Same reading as the `PATCH /api/config` handler, which runs it only when `master` or `defaultEngine` is in the body.]
- [DECISION: the inference stays as the fallback for a payload without `configuredEngine`. | The page and the server are deployed together, but a page left open across a deploy reads a new server and a cached page can read an old one; sending nothing on an unstated engine costs only the convenience.]

**Tests.** `test/setup-wizard.test.js`, in the route's own `describe`: a mode recorded for the previous default engine is reset, said in `warnings` and logged once with both engines and the mode; a mode with no engine recorded is reset the same way; a pinned Master is untouched; the default engine sent unchanged, or not sent, changes nothing; a mode already recorded for the engine the default becomes is kept; a `default` mode says nothing; a refused request stores and logs nothing. `test/master-launch-mode.test.js`: the status payload states the pin, the default engine while another stands in, and `null` (present, not absent) when nothing is set. `test/master-launch-mode-ui.test.js`: the view with the stated engine against every reading of the page's default engine, the foreign mode sent untouched with no pin, the stale page copy, the dropdown off the stored pin, agreement with the pin over every bundled engine and mode, `null`, and the real `getMasterStatus` payload fed to the view under a substitution and with no engine set (foreign exactly when the server's own answer is that the mode does not run); two saves answered by the server's rule. The form harness's read-back now states the engine, as the server does. Ten of the new cases fail on the tree before this change (run in a scratch copy).

**Not built here.** No browser has drawn this change: the modal's screens ride the deferral approved for Chunk 02 (the Integrator, 2026-10-10 18:15 PDT), checked once on the live install after the batch's deploy. The first-run wizard's line for a reset reads "Setup finished, but 1 item(s) were skipped: The Master's launch mode is reset to …": true in its second half and wrong in its first, and `public/setup.js` is outside this chunk. Reaching it needs a Master holding a non-default mode on an install whose setup is run again, since a first run has no Master settings yet. When the dropdown is moved off the stored pin onto "follow default engine", the engine it then stands for is still the page's copy of the default engine: the status payload states the engine set now, not the default engine apart from the pin.
## 2026-10-10 — #2244: a recovery-mode decision records the proof it was taken on

<!-- prawduct: type=bugfix | scope=2244-recovery-decision-provenance -->
#2244 Chunk 01, the issue's only chunk. Branch `fix/2244-recovery-decision-provenance`, from `origin/main` `abecb84d`.

Visual change: yes

**Why.** `PATCH /api/projects/:name` naming `launchSequence.recoveryMode` recorded who decided as the caller kind the operator guard resolved. Where the login stands down (`open`, and `fallback`) that guard takes any request with the dashboard's shape as the operator, so the stored decision, the `project.recovery-mode-decided` activity event and the server log all read `operator` for a request that identified nobody. A decision made with the login off kept reading `operator` after the login was turned on, and nothing told it apart from a signed-in operator's. The recovery clear already kept the two apart; the decision did not.

**What changed.**
- `server.js`: `_operatorProofOf(req)` answers the proof behind a request already admitted as the operator's: `operator-verified` for an `armed` gate, a session and that session's CSRF token on the request; `open-install-unverified` for everything else. The PATCH handler records its word as the decision's `decidedBy`. `_requireOperatorWrite` returns the same function's answer at its two successful ends, so the clear and the decision cannot disagree; what it refuses, and in what order, is unchanged. Nothing else in the file.
- `lib/projects.js`, `lib/store.js`: JSDoc and one comment say what `recoveryDecisionBy` and `recordDecision`'s argument now hold. No logic change: the response, the activity event and the log line already carried whatever word arrived.
- `public/ui.js`: `RECOVERY_DECISION_PROOF_READOUT` words each proof, and `projectRecoveryReadoutHtml` prints it whatever the login's state is now: "by a signed-in operator", or "while TangleClaw's login was not in force, by a request with the dashboard's shape: nobody was identified", each followed by the recorded word. Any other word takes the sentence the panel had before.
- `docs/adr/0017-phased-launch.md` (R3's sentence about `open-install-unverified` is now true of the code; the open question is as written), `docs/configuration-reference.md` (the PATCH and GET rows), `docs/user-guide.md`, `docs/engine-guide.md`.

**Decisions.**
- [DECISION: the proof word is stored in `pinned_by` and returned as `decidedBy`; no schema change and no second field. | The issue asks for the proof word and nothing asks for the username. | Settled by the Integrator with the plan (Q1, answer a).]
- [DECISION: decisions already on record are left reading `operator`, and the panel keeps its "the record does not say" sentence for them. | Any value written over an old row would be a guess. | Settled with the plan (Q2). That sentence still appears only where the login is not in force now, as before: an old record read on an install that has since turned its login on shows `recorded as made by "operator"` with no caveat. Reported to the Integrator, not changed here.]
- [DECISION: a decision taken in `fallback` is recorded `open-install-unverified`, and who is admitted does not change in any gate state. | TangleClaw's login stands down there and cannot say who came through Caddy's. | Settled with the plan (Q3).]
- [DECISION: `_operatorProofOf` defaults to the unverified word. | A gate state it does not know can then never be recorded as a verified person.]
- [DECISION: the panel prints a word it has no sentence for as the server's own, through the old branch, and does not treat it as an error. | That branch is what an old `operator` row takes, and the panel's rule everywhere is to print the server's word and never the nearest one it knows.]

**Tests.** `test/project-recovery-mode-control.test.js`, against the real handler: for every login gate state, the status a save is answered (the three that take it and the three that refuse), and for a save taken, the proof word in the answer, the stored row and the activity event, never `operator`; the read the panel renders from; the server log line; a decision made with the login off still reads `open-install-unverified` after the login is turned on, and a signed-in operator deciding again replaces it with `operator-verified` while the activity log keeps both; an armed session with no CSRF token is refused and records nothing. `test/launch-readiness-panel.test.js`: the readout for each proof word under each thing the page can know about the login now, the old `operator` word, a word the page does not know, and that the table's keys are the words `_operatorProofOf` names. `test/api-projects.test.js`, `test/api-launch-sequences.test.js`, `test/project-recovery-state.test.js`: the assertions of `operator` that passed through the changed path become the proof words, which is the contract this issue changes.

**Not verified here.** The panel in a browser. The check is deferred, approved on this lane's row: TangleClaw-Builder1 does it on the live install after the deploy with the Operator's browser. The PR lists the screens and what each must show. The tests cover the exact markup the panel function returns, not layout at any width. An install with no login was not run by hand: the tests reach `open` and `fallback` through the real request handler on a scratch store.

## 2026-10-10 — #2197: the Master settings modal follows the engine and shows what a save reset

<!-- prawduct: type=bugfix | scope=master-2197 -->

#2197 Chunk 02 of three. Branch `fix/2197-master-modal-follows-engine`, from `origin/main` `0ecaa758`. The modal's half. Chunk 03, the setup route, is still to come, and the issue stays open until it merges.

Visual change: yes

**Why.** After Chunk 01 the server reads a launch mode sent with a new engine as a choice for that engine. The Master settings modal sent the launch mode on every save, read from a control drawn for the engine stored before the operator moved the engine dropdown. So changing the engine in the modal still told the server the old mode had been chosen for the new engine, and was refused with `400` where the new engine does not define it (Claude Code on Accept Edits to Aider). The modal also showed the old selection whenever the new engine defined a mode under the same key, said a stranded choice "is kept and applies again if you switch back", which Chunk 01 made false, and never read the save's `warnings`.

**What changed.**
- `public/api-helper.js`, the Master settings component: the launch-mode control is drawn by one function, `masterLaunchModeMarkup`, at open, when the engine dropdown moves (`renderMasterLaunchMode`, on the dropdown's `change`), and after a save (`adoptSavedMasterSettings`, which reads `GET /api/master/status` back first). Moving the dropdown to another engine lists that engine's modes from the page's engine roster and selects Interactive; moving it back shows what is stored. The control marks itself with `data-send` once the operator changes it, and `saveMasterSettings` sends `launchMode` only then. After an engine move the mode left alone is therefore omitted, which is how the server knows none was chosen for the new engine: it resets the mode and answers the notice. A save's `warnings` are drawn under Launch mode, where they stay until the control is drawn again, and the status line, which hides itself after three seconds, says a notice is there. The "kept and applies again if you switch back" sentence is removed.
- `public/api-helper.js`, two pure helpers beside `tcLaunchModePatch`: `tcMasterEngineModes` (an engine's honored modes from the roster) and `tcMasterLaunchModeView` (what the control shows for a dropdown value: the engine it stands for, whether that is another engine than the stored one, the modes, the selection, and whether a save must send it).
- The engine the modal compares is the one set for the Master: its pin, else `config.defaultEngine` as the page holds it, else the engine the server resolved. Pinning the engine the Master already follows, or removing a pin that restated the default engine, is not a change of engine, as on the server.
- While another engine stands in for the one that is set, the control lists the modes of the engine that is set and says which engine is standing in and what it will start in.
- A stored mode that belongs to another engine than the one set is shown as that, not as selected here. With the engine pinned, and the dropdown still showing that pin, the selection is also sent on a save: the server's notice for that case asks for Interactive to be saved first, and a control that already shows Interactive and sent nothing would never do it. With no pin, or once the dropdown holds anything else, nothing is sent untouched, because which engine is set is then the page's reading and not the server's word (see "Not built here").

**Decisions.**
- [DECISION: after an engine move the modal does not send the Interactive it shows. | The first build sent it, so the server read a choice of `default`, reset nothing in its own terms and answered no warning: the operator was told before the save and not by it. Omitting the mode leaves the reset, and its wording with both engines and both modes, to the one place that defines it. Found by the cumulative review. | R2.]
- [DECISION: the control carries whether its value is a choice (`data-send`), and the save reads that, with no helper call and no remembered state inside `saveMasterSettings`. | `saveMasterSettings` is lifted out of the component and run alone by `test/master-launch-mode.test.js`; a form that says for itself what it was drawn from cannot disagree with a closure that went stale. The plan's second helper, for what the save sends, is therefore not a function: the rule is one attribute, set in two places. | Within the plan.]
- [DECISION: the save's notice is drawn under Launch mode and only pointed at from the status line. | The plan said "shown in the modal's status line". That line hides itself after three seconds, which is not long enough to read that a setting the operator did not touch was reset. | Departs from the plan's wording, not from R2.]
- [DECISION: the form reads the status back after a save. | Otherwise it goes on comparing the dropdown with the settings it opened with: after a reset, moving the dropdown back would show the mode the save had just reset, as selected. One more `GET /api/master/status` per save. If that read fails the control is withdrawn and a line says to reopen the modal: drawn from the settings the form opened with, it could send a mode nobody chose on the next save.]
- [DECISION: with a stand-in running, list the configured engine's modes rather than refuse to choose. | The plan offered either. The roster holds every engine, installed or not, so the list is available, and the operator can still set the mode they want for when the engine is back.]
- [DECISION: when the dropdown is moved to "follow default engine" on a page that does not hold the config, no mode is listed and none is sent. | The page cannot name the engine, so it cannot list its modes; the server then keeps or resets the mode by its own rule and the save's notice says which.]
- [DECISION: the notice uses `<strong>` inside a `form-hint`, not the `form-hint--caveat` class. | `session.css` does not define that class, and `test/master-settings-css-parity.test.js` refuses a class styled on one page only. No stylesheet is on this chunk's list.]

**Tests.** New `test/master-launch-mode-ui.test.js`: the two helpers over every bundled engine profile (every stored engine and mode against every other engine, the empty pin read as the default engine in both directions, an unknown default engine, a mode recorded for the engine being switched to, a stand-in, a stranded mode, a payload with no recorded engine, no settings); the real component over a form that parses what it renders (the list and selection as the dropdown moves and moves back, the shared `bypassPermissions` key, each notice, each way of having no list, escaping, the live region); the save body for each case; and saves answered by the server's own rule, `masterLaunchModeAfterPatch` with its two notice functions over the bundled profiles in a temporary store, so a notice appears in a test only where the server would send one (the reset on an engine change, a picked mode stored with no notice, an unrelated save, Accept Edits to Aider no longer refused, a foreign mode cleared, the status read back, a second save); then the read-back failing (the control withdrawn, and the next save not resetting a mode just chosen), a failed save, and an answer with no `warnings`. **`test/master-launch-mode.test.js`: harness only, no assertion changed or removed.** Its two vm sandboxes lift the modal's functions by name, so `render()` lifts four more (`tcHonoredLaunchModes`, `tcMasterEngineModes`, `tcMasterLaunchModeView`, `masterLaunchModeMarkup`), the fake launch-mode select gains `dataset: { send: '1' }` (it stands for a mode the operator picked), and `save()` gains a no-op `adoptSavedMasterSettings`. File added to this chunk's list by the Integrator.

**Not built here.** The screen check of the modal is deferred to the live install after the batch's deploy (the Operator's `lane-b screens ok`, on this lane's row): no browser has drawn this change. `POST /api/setup/complete` still changes `defaultEngine` without the rule (Chunk 03). `GET /api/master/status` does not say which engine is set for the Master. With no pin the modal reads it from the page's copy of the config, else from the resolved engine, and either can be wrong (a copy loaded before the default engine changed; a stand-in). A wrong reading can list the wrong engine's modes and can describe a validly stored mode as belonging to another engine. It cannot change what is stored: nothing is sent unless the operator changes the control, a mode picked for an engine that does not define it is refused by the server with a message naming the engine, and the form reads the status back after every save. The second cumulative review found the first build sending Interactive on such a reading. The complete fix is one field, `configuredEngine`, which `lib/master.js#_masterRuntime` already returns and `getMasterStatus` does not pass on; `lib/master.js` is not on this chunk's list, and it is written into the plan for Chunk 03. The server's unused-mode notice still says "save Interactive first", including where no engine is set at all (`lib/master.js`, same reason). A failed save's message is still shown only in the status line, for three seconds; that is as it was. On the session page the status line has no ok or error colour (`session.css` defines `rules-status` only); as it was.
## 2026-10-10 — #2178: no Clear recovery button for a launch whose session has ended

<!-- prawduct: type=bugfix | scope=2178-clear-recovery-ended-session -->
#2178 Chunk 01, the issue's only chunk. Branch `fix/2178-clear-recovery-ended-session`, from `origin/main` `0ecaa758`.

Visual change: yes

**Why.** The Launch readiness panel rendered **Clear recovery** on every operator-held launch whose recovery was `required`, including one whose session had been killed, crashed or wrapped. `POST /api/sessions/:project/launch/recovery-clear` refuses that clear with `409 SESSION_ENDED` (#2049), the panel re-read after the refusal, and the same button was rendered again. `GET /api/launch-sequences` carried nothing about the session, so the panel could not tell an ended session's row from a live one.

**What changed.**
- `lib/launch-recovery-clear.js`: `sessionIsActive(session)` is the one judgement of whether a launch's session is still there for a clear to let through (a row whose stored status is `active`; a missing row is ended). `clearOneLaunch` uses it. The route's behaviour is unchanged.
- `server.js`: each row of `GET /api/launch-sequences` carries `sessionActive`, from that same function. Nothing else in the file.
- `public/ui.js`: `launchRecoveryHtml` renders, for an operator-mode `required` launch whose row says `sessionActive: false`, the verdict and cause as before, then a sentence in place of the button: the launch was never cleared, its session has ended, there is nothing to clear, and a new session of the project has a launch of its own.
- `docs/configuration-reference.md` (the `GET /api/launch-sequences` row) and `docs/user-guide.md` (one bullet under the launch panel).

**Decisions.**
- [DECISION: the field is a boolean computed by the function the clear route refuses on, not the stored status word. | A status word would make the browser repeat the route's rule, and the two could then disagree. | The plan's assumption A1, kept.]
- [DECISION: only an explicit `false` removes the button; a row with no such field, or `null`, keeps it. | A page served by a newer build can meet an older server's row during an update, and the route still decides either way. | The plan's assumption A2, kept.]
- [DECISION: an ended session's row says nothing about the project's mode now ("its next launch will use that"). | That sentence exists to say this launch still waits for a clear while the project has moved on; an ended launch waits for nothing.]
- [DECISION: advisory and cleared rows are untouched. | Neither ever had the button, which is the defect.]

**Tests.** `test/api-launch-sequences.test.js`: one launch per stored session status (the test fails if a status is added and not exercised), each row's `sessionActive` held against `sessionIsActive` asked of the same session. `test/launch-readiness-panel.test.js`: the real `launchRecoveryHtml` in a `vm` context: no button and the sentence for `false`; cause and log pointer still shown; the button for `true`, absent, `undefined` and `null`; advisory and cleared rows unchanged. `test/launch-recovery-clear-ended.test.js`: for a killed, a crashed and a wrapped session, the row read over HTTP is rendered by the real panel function with no button, and the route answers `409 SESSION_ENDED` for that launch; for an active session the binding is read off the rendered button, sent, and the route clears it; a session that ends after the panel was read has its stale click refused and its re-read drops the button.

**Not verified here.** The panel in a browser. The check is deferred, approved on this lane's row: TangleClaw-Builder1 does it on the live install after the deploy with the Operator's browser. The PR lists the screens and what each must show. The tests cover the exact markup the panel function returns, not layout at any width.

## 2026-10-10 — #2197: the Project Master's launch mode belongs to the engine it was chosen for (server)

<!-- prawduct: type=bugfix | scope=master-2197 -->
#2197 Chunk 01 of two. Branch `fix/2197-master-engine-mode-reset`, from `origin/main` `a6ebf695`. The server's half. The settings modal is Chunk 02, and the pair is the fix: until Chunk 02, the modal still sends the old mode with a new engine, which this chunk reads as a choice for the new engine, and refuses with `400` when the new engine does not define that mode (Claude Code on Accept Edits to Aider, from the modal, was accepted before).

Visual change: no

**Why.** A launch mode stored for the Master was honored on whatever engine the Master ended up on, as long as that engine defined a mode under the same key. `bypassPermissions` skips approvals on Claude Code; on Codex it also removes the sandbox. An operator who chose it for one engine and then changed the engine got the other engine's meaning without choosing it and without being told. #2189 fixed this for projects. The Master was left on the old rule, which #756 had chosen on purpose: the mode was to outlive an engine switch so that switching back restored it. **This reverses that #756 decision.**

**What changed.**
- `lib/master.js`: `master.launchModeEngine` is the engine a non-default mode was chosen for, read by `masterSettings`. `masterConfiguredEngine` is the engine set for the Master (its pin, else the default engine). `masterLaunchModeOwner` is the engine the stored mode belongs to. `masterLaunchModeAfterPatch` is the one rule for what a save leaves: on a change of the configured engine the mode returns to `default` unless the same save sends one, a sent mode is a choice for the engine the save leaves the Master on and must be one of its modes, and the stored mode sent back unchanged is no choice. `masterLaunchModeResetWarning` words the notice with both engines and both modes. A stored mode sent back while it belongs to another engine than the one set (reachable when the engine changed where no save saw it) is not moved, and `masterLaunchModeUnusedWarning` says it will not run and how to choose one that will; a non-default mode with no engine recorded and none configured starts as `default`. Both came from the Critic. `_masterRuntime` runs the stored mode only when the engine that starts is the one it was chosen for, and returns `launchModeEngine`; `getMasterStatus` carries it. The comments that described the mode outliving an engine switch are rewritten.
- `server.js`: `validateMasterPatch` refuses `launchModeEngine` from a caller and carries the stored one. The `PATCH /api/config` handler applies the rule once, after both engine fields are read, when the request names `master` or `defaultEngine`; it refuses a mode the engine does not define with `400`, logs a reset, and answers `{ok, config, requiresRestart, warnings}`. A reset is also appended to the `500 MASTER_LEVEL_NOT_APPLIED` message, since that answer has no `warnings`.
- `docs/configuration-reference.md`: the `master.launchMode` row (its type and default were also wrong: it is a string, `"default"`), a row for `master.launchModeEngine`, and the `PATCH /api/config` row.

**Decisions.**
- [DECISION: a mode belongs to the engine SET for the Master, never to an engine substituted for it. | The save path then needs no detection of what is installed, so a save's answer does not depend on the machine, and a stand-in engine can never be handed a non-default mode. The cost: while the configured engine is not installed, a mode cannot be chosen for the stand-in; the Master starts in `default` until the configured engine is back or the operator sets the engine they mean. | Within the plan's "substitution in scope" decision; the plan did not say which engine a mode chosen during a substitution is for.]
- [DECISION: the rule is applied in the route, after the loop over the request's fields, and not inside `validateMasterPatch` as the plan worded it. | The Master's engine can come from `defaultEngine` in the same request, in either key order, and the validator sees only the `master` object. One call site instead of two. | Same two functions of `server.js` as planned.]
- [DECISION: a save records the engine of a mode stored before the field existed. | The runtime already reads such a mode as chosen for the engine configured now. Writing that down at the first save means a later engine change that no save sees (a hand edit, the setup route) cannot re-attach it. | The plan's upgrade decision, made durable.]
- [DECISION: the stored mode sent back with an unchanged engine is not judged. | The modal sends every field on every save. Judging it would refuse unrelated saves over a stored mode the engine has since stopped defining, which is the failure #2128 removed for the engine field.]
- [DECISION: `warnings` is always present on the `200` answer, empty when there is nothing to say. | A field present only sometimes makes every reader probe for it.]
- [DECISION: the two log lines keep the words "not honored by the resolved engine" and gain a `chosenFor` field. | `test/master.test.js` pins those words in three cases; they are still true of both causes.]

**Tests.** `test/master-launch-mode.test.js` gains the server's cases on the real functions over the bundled profiles in a temporary store: the pinned engine changing with and without a mode, a mode the new engine does not define, a save that leaves the engine alone, the default-engine path, a mode with no engine recorded, the notice's words, and the launch when another engine stands in (the command built for Codex carries no `--dangerously` flag). `test/api-config.test.js` gains the route's cases: the stored block, `warnings`, both engine fields in one request in either order, `launchModeEngine` refused, the access-level-only save, the `500` path, and a save naming neither engine field leaving the block as it was. **Two existing expectations changed, both because of the reversal or the new field, neither weakened:** in `test/api-config.test.js`, "accepts a mode the CURRENT engine cannot honor, and keeps it stored" asserted the #756 behaviour and is now "refuses a mode chosen in the same save as an engine that does not define it"; and the whole-shape expectations in `test/api-config.test.js` and `test/master.test.js` gain `launchModeEngine: null`. Two comments in `test/master.test.js`'s #756 block that explained the old rule are reworded; their assertions are untouched. `test/master.test.js` was added to this chunk's files by the Integrator for that.

**Not built here.** `public/api-helper.js` is untouched: the modal still says a mode "is kept and applies again if you switch back", still renders the mode list of the engine stored before the operator moved the engine dropdown, and still sends that mode with the new engine. Chunk 02. `POST /api/setup/complete` can also change `defaultEngine` and does not apply the rule; a Master with a recorded engine is still protected at launch, and one with a non-default mode and no recorded engine is not. `lib/store.js` is untouched, so `GET /api/config` on an install nobody has saved shows no `launchModeEngine` key, which reads as `null`.
## 2026-10-10 — #2262: the operator is told about a silent lane nobody else could be told about

<!-- prawduct: type=feature | scope=2262-workload-nudge -->

#2262 Chunk 05 of five, the last. Branch `feat/2262-lane-silent-producer`, from `origin/main` `a6ebf695`. The producer of the `lane-silent` notification the previous chunk admitted.

Visual change: no

**Why.** The workload nudge monitor records an escalation on the operator route when a lane's expired report drew no answer and no coordinator could be told. That row reached nobody who was not looking, and `tc sessions` said "nothing sent". The case it exists for is a coordinator cleared overnight with the operator on Discord. The Operator ruled on 2026-10-10 that the record reaches them as a typed bridge notification.

**What changed.**
- `lib/bridge-notify.js`: a `lane-silent` template and pass. The pass reads the operator-route `escalated` rows of `workload_nudge_facts` written since the bridge was enabled (or the lookback bound, whichever is later) and enqueues one notification for each that has none, under `notify:lane-silent:nudge-fact:<fact_id>`. `reconcile()` returns its count as `laneSilent`. `laneSilentNotice(factId)` reads the state of that fact's item in the outbound queue. `LANE_SILENT` holds one fixed sentence per reason code.
- `lib/store.js`: `workloadNudgeFacts.listOperatorEscalations({since, after, limit})`, one page oldest first by `(created_at, fact_id)` with `more` and a cursor. Also one `log.info` in the v62 step for a store that had no bridge tables, which that step's review asked for.
- `lib/workload-fleet.js`: the lane's `nudge` block gains `operatorNotice`.
- `lib/tc-verbs.js`: the operator-route clause in `tc sessions` no longer ends "nothing sent". It reads "recorded for the operator" and then what became of the notice.
- `lib/workload-nudge.js`: three strings and the header paragraph that said nothing reads the operator route. No behaviour.
- Docs: `docs/fleet-workload.md`, `docs/operator-bridge.md`, `docs/configuration-reference.md` (the `workloadNudge` row), `docs/discord-operator-notifications.md`, and one sentence of ADR 0023 Decision 9's amendment, which said nothing raises the type.

**Decisions.**
- [DECISION: `tc sessions` says "notified" only for a notice the helper reported posted, and names the other states. | The wording settled at release was "recorded for the operator" from the record and "notified" when an outbound row exists. An outbound row can be waiting, set aside, or let go uncollected, and in none of those was anybody told. The block carries the item's state (`ready`, `blocked`, `delivered`, `dropped`, or null) and the line says `notice queued, not yet delivered`, `notice held, not delivered`, `notice not delivered`, `notified`, or `no notice raised`. | Stricter than the settled wording, not looser; reported to the Integrator in the PR.]
- [DECISION: the notice does not show the coordinator's name. | The name is in the fact's detail, and it comes from a project's config file: text somebody typed. The typed notifications take only what the server resolved. The reason is given as a fixed sentence per code.]
- [DECISION: the reader pages with a cursor and the pass reads every page. | A pass that read only the oldest N rows would stop making notices once N made ones sat ahead of a new one. The window is bounded by the 24 hour lookback, and each page by its limit.]
- [DECISION: the minutes in the notice are those the monitor recorded with the fact. | Recomputing them at enqueue time would need the receipt and a clock, and a notice enqueued on a later pass would then disagree with the record it is bound to. The docs say what the number is.]

**Tests.** `test/bridge-notify.test.js`: one fact makes one notice with its exact text and key, and a second pass none; a coordinator-route escalation, an undeliverable row, a nudge and a not-nudged row make none; nothing from before the bridge was enabled, while it was off, or older than the lookback; every reason code the monitor can record on the operator route has a sentence, and an unknown or inherited one falls back; the coordinator's name and an unreadable detail are not shown; a failed enqueue is retried under the same key; every page is read; the templates are exactly the admitted types. `test/workload-nudge-facts.test.js`: the reader's filter, order, inclusive bound, `more`, cursor across facts of one instant, and refusal of a limit it would have to cap. `test/workload-fleet.test.js`: `operatorNotice` over the HTTP route, from null to `ready` to `delivered`, and null on a coordinator-route lane. `test/tc-verbs.test.js`: each state's wording, and that only `delivered` reads "notified".

**By hand, once.** The one-process check (scratch home, private tmux server, real store, real monitor timer, the real pass): result in the PR.

**Not built here.** No helper or Discord delivery was exercised. `lib/medusa.js`, `lib/bridge-gateway.js`, `lib/bridge-store.js`, `lib/bridge-schema.js` and `public/` are untouched. No schema change.

## 2026-10-10 — #2262: the operator bridge admits a fourth typed notification, `lane-silent`, and nothing raises one yet

<!-- prawduct: type=feature | scope=2262-workload-nudge -->

#2262 Chunk 04 of five. Branch `feat/2262-bridge-lane-silent`, from `origin/main` `1539626c`. Everything the operator route's producer will stand on, and nothing that sends. The producer is Chunk 05.

Visual change: no

**Why.** A silent lane with nobody to tell is recorded on the operator route and reaches nobody. The Operator ruled on 2026-10-10 that this record is to reach them as a typed bridge notification, which amends ADR 0023 Decision 9. The bridge's notification types are a closed list held in three places, and one of them is a CHECK on `bridge_outbound.notify_type`, which SQLite cannot alter in place. Admitting the type therefore rebuilds the live outbound queue's table, and that is reviewed here on its own, apart from the code that will write to it.

**What changed.**
- `lib/bridge-schema.js`: `lane-silent` joins `NOTIFICATION_TYPES`, so the DDL's CHECK admits it. The shape marker `BRIDGE_SCHEMA_VERSION` goes from 54 to 62, `LATER_VERSIONS` gains 62, and `bridge_outbound` gains a `needsSince62` fragment, which is how an old table is recognised and rebuilt. `hasBridgeTables` is new: whether a store holds any bridge table.
- `lib/store.js`: `CURRENT_SCHEMA_VERSION` 62 and the v61 to v62 step, `_migrateOperatorBridgeV62`, which calls `upgradeBridgeTables` as the v53 and v54 steps do: prove the store is a sound v61 store, rebuild the one stale table with every row, column and id and the id sequence, then re-create and verify the whole bridge schema, in one transaction.
- `lib/bridge-store.js`: `EXPIRY_MS.notification` gives `lane-silent` 7 days, as `work-blocked` and `operator-needed` have.
- `docs/adr/0023-master-mediated-operator-bridge.md`: Decision 9 amended with the ruling, the type's producer, its limit, and that it is admitted before it is produced; Decision 8 item 2 reads "four".
- `docs/operator-bridge.md`: the status table, the notifications section, the storage section (v62) and the retention table.

**Decisions.**
- [DECISION: the bridge's shape marker is 62, not 55 as the plan and the lane row said. | The marker and the `needsSinceN` keys are store schema versions: `upgradeBridgeTables(db, from)` checks the store against what version `from` required. Numbered 55, a real v55 to v61 store would be judged against a shape it never had and refused as unsound. | The plan is corrected; reported to the Integrator.]
- [DECISION: a v61 store with no bridge table at all is not refused: its bridge storage is created whole. | `upgradeBridgeTables` refuses a store that is not sound, and a store with no bridge tables is not a sound v61 store. But `test/session-rule-lifecycle.test.js` builds a store stamped v55 holding only the tables it tests, and until now every boot simply created the bridge's tables for it. Refusing would have broken that test, which is not this chunk's to change, and there is nothing in such a store to protect. A store holding some bridge tables and not others is still refused, before anything is touched. | Not in the plan; reported to the Integrator.]
- [DECISION: `lane-silent` goes last in the list. | The v61 table's SQL is then the v62 SQL with one item removed from the end of the list, which is what the migration test's v61 store is built from.]

**Tests.** `test/store-bridge-migration.test.js`: a v61 queue refuses the type; a v61 store whose queue was filled through the bridge's own writers (an item waiting, one under a live lease, one delivered in two messages, one set aside, one withdrawn, a status item, and two removed) migrates with every column of every row of the queue, its parts, leases and claims unchanged, has the shape of a fresh store, accepts `lane-silent`, still refuses the two reserved types, does not reuse a removed item's id, and still works as a queue afterwards; a second boot rebuilds nothing (the table's root page is unchanged); an unsound v61 store and one that lost its queue table are refused with the stamp left at 61; a store with no bridge tables is created whole; the v62 shape satisfies what versions 52, 53, 54 and 61 required. `test/bridge-retention.test.js`: the exact limits and the boundary test gain the fourth type.

**By hand, once.** The migration was run on a scratch copy of a copy of the live v61 database that the Integrator took with `sqlite3 .backup`. The result is in the PR.

**Not built here.** No template, no pass and no caller: nothing on this commit queues a `lane-silent` item. `lib/bridge-notify.js`, `lib/medusa.js`, `lib/bridge-gateway.js` and `public/` are untouched.
## 2026-10-10 — #2271: `CLAUDE.md` names the lane test bed's changelog exception

<!-- prawduct: type=docs | scope=docs-2271 -->
Chunk 01, the plan's only chunk. Branch `docs/2271-batch1-doc-corrections`, from `origin/main` `1539626c`.

Visual change: no

**What was wrong.** `CLAUDE.md`'s Core Rules say "Update CHANGELOG.md with every change", and the mirrored Releases & Versioning rule has each merged PR add to `[Unreleased]`. In a lane test bed project the project's own rules say the opposite for a Builder: `CHANGELOG.md` and `FEATURES.md` stay off its branch, and the Integrator lands the batch's entries in one records PR. The section that exists to record where this repo departs from those rules did not say so, so a session that read only the file a fresh clone gets would follow the Core Rule.

**What changed.** One bullet added to "This Repo's Exceptions To The Global Rules Below". It says that in a lane a Builder does not edit `CHANGELOG.md` or `FEATURES.md` on its branch and puts those entries in the PR description; that `.prawduct/change-log.md` is the other way round and the Builder does add its entry there; that this holds only in a clone launched as a lane; and that the project's own rules, read with `tc rules`, are the authority.

**Decided.** The exception is scoped to lane clones, because `CLAUDE.md` is shared by every checkout of this repo and most are not lanes. It points at the rules by how they are read, not by number: rule numbers differ per project and change when a rule is replaced. "Core Rules" is left as written, since it is right everywhere else.

**How the commit was built.** Every clone's `CLAUDE.md` carries the server's own uncommitted rewrite of its generated block. The edit was made in a copy of the committed file and put in the index with `git update-index --cacheinfo`, so the working file was never staged. Read before committing: the staged diff was the one hunk in the exceptions section, and the working diff's two hunks were the server's, unchanged.

**Not in this change.** The issue's other two items are about files git ignores, so no commit carries them. Item 1 (the preferences file's merge-strategy lines contradicting each other) is corrected in this lane's own copy and the replacement text is in the PR description for the other clones; it does not settle #2162, which stays open. Item 3 (a session's rules file going stale when a rule changes mid-session) is a product gap, filed as #2273.

**Not covered.** Whether a session that reads only `CLAUDE.md` now behaves differently: that is judgment, not something a test shows. No test reads the exceptions section; `test/repo-governance-reference.test.js`, the one test that reads this repo's own `CLAUDE.md`, passes.

## 2026-10-09 — #2262: a nudge that goes unanswered is escalated once, to the coordinator the lane names

<!-- prawduct: type=feature | scope=2262-workload-nudge -->

#2262 Chunk 03 of four. Branch `feat/2262-nudge-escalation`, from `origin/main` `013e4c8b`. The escalation to a coordinator. The operator route is recorded and delivers nothing: that is Chunk 04, parked on a question for the Operator.

Visual change: no

**Why.** A nudged session that still does not report left its coordinator where it was before the nudge existed: the lane reads UNKNOWN and nothing says whether anyone noticed. `coordinatorProject` and `escalateAfterMinutes` have been stored and not acted on since the setting landed.

**What changed.**
- `lib/workload-nudge.js`: a nudge that no fresh receipt answers within `workloadNudge.escalateAfterMinutes` becomes one switchboard message (`lib/medusa.js#sendSystemMessage`) to the live session of the project named in the silent lane's own `workloadNudge.coordinatorProject`, and an `escalated` fact on the `coordinator` route. `escalationBody` is a fixed template over values the module resolved: the lane's project name, minutes silent, whether and when it was nudged, and the observer's reading. Nothing from a receipt's summary or the project's nudge text reaches it.
- A lane that could not be nudged is escalated once the same time has passed since its report expired, with a `not-nudged` fact carrying the reason at that moment: no pane, an engine with no wake profile, a startup dialog, a pane that could not be typed into, or an engine observed busy, not at rest or unknown. A lane that is held or stopped, or running a wrap, is neither nudged nor escalated.
- A lane with nobody to tell gets an `escalated` fact on the `operator` route and no message to any project: no coordinator named, the lane naming itself, a name that matches no project, a coordinator with no live session, or a coordinator the Hub would not take a message for. When a coordinator was named, why it could not be reached is its own `escalation-undeliverable` row. Each outcome's code has a declared meaning (`ESCALATION_MEANINGS`).
- `lib/workload-fleet.js`: the lane's `nudge` block gains `notNudgedReason`, `escalatedAt`, `escalatedAgeSeconds`, `escalationRoute` and `escalatedTo` (the coordinator project's name). The block now also appears on a lane escalated without a nudge, with `nudgedAt: null`.
- `lib/tc-verbs.js`: the lane's line in `tc sessions` reads `; nudged 14m ago, escalated to TC-Lane-INT 4m ago`, `; not nudged (startup dialog), escalated to …`, or, on the operator route, `; nudged 14m ago, nobody to escalate to: recorded for the operator 4m ago, nothing sent`.
- `_judge` is split before it is extended, as the last chunk's review asked: the context a lane is judged from, the decision whether its pane may be typed into, the nudge, the decision who is told, and the two escalation acts are separate functions. The verdict log line names the project.
- `docs/fleet-workload.md` gains the escalation, the table of what a lane's line can end with, and the Limits the issue asks for. `docs/configuration-reference.md` loses the sentence saying the two escalation keys are not acted on.

**Decisions made while building, beyond the plan.**
- **The message is sent first and `escalated` recorded after the Hub accepts it**, the same order as the nudge and for the same reason: the table is append-only and must not say a coordinator was told who was not. A message accepted whose record then fails is kept in memory, written on a later tick and not sent again by that process. A server restart while the store still refuses the write is the one case in which a coordinator can get the message twice for one expiry. It is in the docs under Limits.
- **The tick does not wait for the send.** `sendSystemMessage` has no timeout of its own, and a Hub that hangs would otherwise hold up every other lane's nudge. A send in flight is not started again; `settled()` lets a caller driving the monitor by hand wait for it. A session that reports while its escalation is already with the Hub is still escalated for that expiry; that is in Limits too.
- **A send that keeps failing is given up after five attempts by one server process** (`MAX_SEND_ATTEMPTS`), and the coordinator is then recorded as unreachable with an operator-route fact. The plan says only "retried next tick, never counted as sent". Unbounded, a Hub that is down for the night would leave a silent lane recorded as nobody's to hear about. The count is in memory and starts again after a restart.
- **An engine observed busy counts as "could not be nudged".** Assumption A2 lists a pane "not at rest for the whole escalation window". A session that has not reported for its expiry and ten more minutes is what the coordinator needs to hear about whatever its pane shows, and the message says the engine was observed busy.
- **"For the whole window" is judged at the deadline, not tracked.** A lane's reason for not being nudged is the one in force when the escalation falls due. No history of earlier ticks is kept, so a restart changes nothing. A pane that comes to rest before the deadline is nudged, and the time then runs from the nudge; a pane first typeable after the deadline is nudged on that tick and not escalated on it. A lane already escalated without a nudge is not nudged later for that report: its coordinator was told it was not. One narrow case remains: a pane that comes to rest while that escalation's message is still with the Hub, or between failed attempts, is nudged.
- **A coordinator that could not be reached is not tried again for that expiry**, even if its session comes back: the unreachable row and the operator-route row are the record of what happened.
- **The block has two keys the plan did not name**: `escalationRoute`, because a line must not say a lane was "escalated to" anyone when nothing was sent, and `escalatedAgeSeconds`, because `lib/tc-verbs.js` renders ages the server computed.
- **One existing test changed.** `already-nudged: a second tick types nothing` asserted the lane still read `already-nudged`, with one fact, five hours after its nudge. That is now past the escalation deadline, so it asserts the escalation there and still asserts the pane got exactly one line. One assertion in `test/workload-fleet.test.js` named the block's exact keys and names the new ones.

**Checked against a real pane, not a second server.** On `7fd9708a`, one node process with its own `HOME`, `TANGLECLAW_HOME` and tmux server ran the real store, the real timer (2 s), the real `injectCommand`, the real workspace registry and three throwaway projects on real `cat` panes, with `escalateAfterMinutes` 2 and the switchboard send replaced at the module's seam. Observed: the silent lane was nudged once and nothing was sent one minute later; two minutes after the nudge by the real clock one message went to the coordinator project's workspace id, the `escalated` fact named the coordinator, and the lane's line ended `; nudged 2m ago, escalated to scratch-coordinator 0m ago`; three more ticks and a stop and start of the monitor sent nothing more and typed nothing more; nothing was typed into the coordinator's pane; a fresh receipt gave `receipt-current` and a null block. A second lane, 45 minutes silent, read not-at-rest and naming no coordinator, got a `not-nudged` and an operator-route `escalated` fact, no message, and a line ending `; not nudged (engine not at rest), nobody to escalate to: recorded for the operator 0m ago, nothing sent`. Not covered: a message accepted by the real Hub and arriving in a coordinator's inbox, the timer in a booted server, the route over HTTP on a running server (covered on a test server), and a real engine pane at rest (the reading was stubbed).

**Tests.** `test/workload-nudge.test.js`: not yet due, due and sent once, a second tick and a restart, the project's own minutes, a fresh receipt before the deadline, the coordinator being whoever the config names, no live session, an unknown name, the lane naming itself or nobody, a send that throws, a send that never succeeds, a send not yet answered, a record that fails after the send and one that fails on the operator route, each reason a lane could not be nudged, the deliberate holds, the message, and what is logged. Additions to `test/workload-fleet.test.js` (the new keys over the real route) and `test/tc-verbs.test.js` (each form of the clause).

## 2026-10-09 — #2262: a session whose workload report expired is nudged once, for projects that ask

<!-- prawduct: type=feature | scope=2262-workload-nudge -->

#2262 Chunk 02 of four. Branch `feat/2262-nudge-monitor`, from `origin/main` `c8fd1142`. The first behaviour of the issue. No escalation yet: `coordinatorProject` and `escalateAfterMinutes` are still stored and not acted on.

Visual change: no

**Why.** A lane whose workload receipt expires reads UNKNOWN and nothing tells the session. A coordinator sees it go quiet and cannot tell a session that forgot to report from one that stopped.

**What changed.**
- New `lib/workload-nudge.js`, a monitor beside `lib/launch-unready.js`, started and stopped in `server.js` and handed the activity observer. Every 30 s, for each live project session whose project sets `workloadNudge.enabled` to exactly `true`: if the session's newest receipt of its live launch expired by age, and the pane was observed at rest, one fixed line is typed into the pane through `lib/sessions.js#injectCommand`, and a `nudged` fact is recorded in `workload_nudge_facts`. The project's `workloadNudge.text` replaces the line whole.
- The judge returns one code per lane from a declared table (`VERDICT_MEANINGS`). Nothing is typed when the project has not turned the monitor on, the receipt is current, the receipt went stale for a reason other than age, the session never reported, the session has no pane or its engine has no wake profile, a wrap is running, the engine is observed busy, not at rest or unknown, the lane is held, or the pane shows a startup dialog. Whether a receipt expired is read from `lib/workload-fleet.js`, never recomputed.
- `lib/workload-fleet.js`: `laneFor` now returns a `nudge` block (`nudgedAt`, `receiptSeq`, `ageSeconds`), null unless the lane's newest receipt is stale and has a `nudged` fact. A new `laneContext` returns the same lane with the receipt's row id and the launch id, which the monitor records against; they stay out of the lane the fleet read returns.
- `lib/tc-verbs.js`: `tc sessions` adds `; nudged <n>m ago, not yet answered` to that lane's line, after the engine's reading.
- `lib/projects.js` loses the `WORKLOAD_NUDGE_NOT_ACTED_ON` save warning and `docs/configuration-reference.md` the sentence that went with it: something reads the setting now. The reference says instead that the two escalation keys are stored and not yet acted on; a save that sets them does not warn. `docs/fleet-workload.md` gains the behaviour and its limits.

**Decisions made while building, beyond the plan.**
- **The line is typed first and the fact recorded after.** The plan left the order open and asked for it to be chosen on purpose. The fact means "this session was told". Every refusal to type (a held lane, a startup dialog, a pane that vanished) happens inside the send, so a fact written first would claim a nudge that reached nobody, in a table that cannot be corrected, and a lane held at that moment would have lost its one nudge. The cost is the case where the line was typed and the write then failed: the process keeps the fact, retries the write each tick whatever the lane says by then, and never types for that receipt again. A server restart while the store still refuses the write is the one case in which a session can get the line twice for one expiry. It is stated in the docs under Limits.
- **A pane's state is the observer's last reading**, up to 30 s old, where `lib/launch-unready.js` captures the pane itself. The plan says to read the observer, and the module holds no tmux call of its own.
- **The lane-held verdict is the pane writer's control refusal.** A lane held through its open control assignment is usually caught earlier: the hold supersedes the receipt, so it reads `stale-not-expired`.
- **No row in `lib/engines.js#ENGINE_CONDITIONAL_SETTINGS`** for `workloadNudge`, which the plan said to check. That table feeds the settings screens and their browser mirror, and this setting has no screen. On an engine whose pane cannot be typed into, the log says so (`unprofiled-engine`, `no-pane`), as it does for every verdict: each session's verdict is logged with its meaning whenever it changes, which is the only place a lane that was not nudged is explained until the escalation records it. The docs name both cases. A save does not warn about it.
- **No activity-log row for a nudge.** The fact is the record; `activity_log` is pruned.
- **30 s tick**, where the unready monitor uses 15 s: an expiry is measured in tens of minutes, and each tick reads each project's config file.
- `laneFor` ignores a receipt row with no integer `receipt_id` when looking for a nudge. An existing test hands it a hand-built row without one.

**Checked against a real pane, not a second server.** The plan's check starts a scratch server from the chunk's commit. That was not done: `lib/tangleclaw-home.js` says a second concurrent install on one machine is unsafe (its state is separable, its ingress is not) and records that an earlier attempt migrated the live database. Instead, on `dd4474f5`, one node process with its own `HOME`, `TANGLECLAW_HOME` and tmux server ran the real store, the real timer (`start`, 2 s), the real `injectCommand` and a real pane running `cat`. Observed: with the real activity observer the pane read `not-at-rest` and nothing was typed; with the reading stubbed to at-rest the timer typed the line once and recorded one fact, the lane's `nudge` block was set and the `tc sessions` line ended `; nudged 0m ago, not yet answered`; further ticks and a stop and start of the monitor typed nothing more; a fresh receipt gave `receipt-current` and a null block; with the setting removed, `monitor-off`. Not covered: the two lines in `server.js` in a booted server, the route over HTTP on a running server for a nudged lane (covered on a test server), and a real engine pane at rest.

**Tests.** New `test/workload-nudge.test.js`: one test per verdict, the budget across ticks and a restart, a failed write (remembered, retried, never typed twice, still recorded when the session answered first), a fact another process wrote first, the line, what is logged, and the timer. Additions to `test/workload-fleet.test.js` (the block over the real route) and `test/tc-verbs.test.js` (the clause). `test/workload-nudge-settings.test.js` loses the test of the removed warning.

**Also in this hunk.** One blank line added between this lane's Chunk 01 entry and the `#2115` heading below it, which Chunk 01 left out; the Integrator accepted it for this PR.

## 2026-10-09 — #2262: the record a workload nudge is counted against, and the setting that will turn it on

<!-- prawduct: type=feature | scope=2262-workload-nudge -->

#2262 Chunk 01 of four. Branch `feat/2262-nudge-record-config`, from `origin/main` `76988eed`. It ships no behaviour: nothing on this branch types into a pane or sends a message.

Visual change: no

**Why it is its own chunk.** A lane whose workload receipt expired is to be nudged once and, if it stays silent, escalated once. Both limits have to hold across a server restart, and a run has to be able to say afterwards how each stall was noticed. `activity_log` is pruned per event type, so neither can rest on it. The issue's charter expected no migration; planning found that these two requirements cannot be met without a table, and a migration is reviewed on its own.

**What changed.**
- Schema v61: `workload_nudge_facts`, one append-only row per fact (`nudged`, `not-nudged`, `escalated`, `escalation-undeliverable`), with where an escalation was bound (`coordinator` or `operator`), the verdict code, and what the activity observer said at that moment. All the kinds and both routes are in the CHECKs now, so the later chunks of #2262 need no further migration. The migration reads the stored DDL back before it advances the version, as v59 and v60 do.
- A fact is unique per receipt, kind and route, and the index reads a missing route as `''`. SQLite treats two NULLs as different values in a unique index, and a `nudged` fact has no route, so a plain index would have admitted a second `nudged` row for one expiry: the exact failure the table exists to prevent. The migration refuses to advance over a table carrying the plain index.
- The same trap, a second time, caught by the review of the merged tree (`rev-20261010T021549Z-0ffc331f`): the CHECK that only a coordinator-route fact may name a coordinator compared `route` with `=`, and a comparison with NULL is NULL, which SQLite does not count as a failed CHECK. A `nudged` fact could have carried a coordinator's project id. It now reads a missing route as `''` too, and the migration checks for that form. Fixed before the merge because afterwards it would have needed a table rebuild in a v62.
- `store.workloadNudgeFacts`: `record` writes a fact once and says whether this call was the one that wrote it (a uniqueness conflict is the expected answer; any other refusal by the table throws), and `listForReceipt`.
- The per-project `workloadNudge` setting: `{ enabled, text, coordinatorProject, escalateAfterMinutes }`, `null` by default so a settings save writes no opinion into a project that never chose one. `lib/project-config.js#resolveWorkloadNudge` reads it; a value that cannot be used falls back for that one setting, and `enabled` falls back to off.
- `PATCH /api/projects/:name` validates the block, merges it onto what the stored block resolves to, and refuses an unknown key, an empty object and each bad value with a message naming the field. The save and the reader share one judgement of each value (`workloadNudgeProblem`), so a value that saves is never one the reader discards.
- `docs/configuration-reference.md` documents the setting and says that in this release it is stored and not yet acted on. A save that leaves the setting enabled also says so in the `PATCH` response's `warnings` (`WORKLOAD_NUDGE_NOT_ACTED_ON`), because a setting must take effect or say why it does not (ADR 0013) and the reference is not where the caller is looking. The chunk that ships the monitor removes both the sentence and the warning; the warning is in `lib/projects.js`, which that chunk's file list does not yet name.

**Decisions made while building, beyond the plan.**
- The plan said a fact's route is "null for `nudged`; `coordinator` or `operator` otherwise". The table requires a route on `escalated` and `escalation-undeliverable`, forbids one on `nudged`, and lets `not-nudged` carry either: a reason for not typing into a pane is not always about a destination, and the chunk that records those facts must not need a schema change to say so.
- There is no accessor for "every stall in a time range", which the plan lists among the questions the table must answer. One was written and taken out after the boundary review (`rev-20261010T015252Z-de270f4f`): it had no caller, and it capped its result without saying rows were left out. The table keeps the `(created_at, fact_id)` index that read will need, because the schema is fixed for the release; the reader belongs to the chunk that has a consumer, and needs `lib/store.js` on that chunk's list.
- A refused value is described in a warning by type and length and never quoted, so a nudge line refused for carrying a control character is not copied into a log by the warning about it. The same holds for a block that is not an object, which is most likely to be the nudge line written as a bare string; the first version quoted that one whole, and the review caught it.
- `coordinatorProject` is held to one safe line of at most 255 characters with no space at either end, which is narrower than the plan's "a non-empty string". It will be written to logs and matched against project names.
- The "one safe line" character classes are written twice, in `lib/workload.js` (workload summaries) and `lib/project-config.js`, because the second cannot import the first: it runs in the scanner child and the first opens the database. `test/workload-nudge-settings.test.js` holds the two to the same answer over a corpus. One home for the predicate needs an edit to `lib/workload.js`, which is outside this chunk's files.

**Not covered.** No module reads `resolveWorkloadNudge` or writes a fact yet, so nothing here has been exercised by a running monitor. The resolver's warnings are returned to a caller that does not exist yet and are logged nowhere. The saved block is not echoed in the `PATCH` response or on `GET /api/projects` (as `launchSequence` is not); it is read back from the project's file. Who may set it is not restricted: a project's own session can, as it can `medusaWake`.

**Checked against a real v60 database.** The migration test makes its v60 store by dropping the new table from a store this branch created, so it never meets a database a v60 server wrote. Separately, a database was created by `origin/main`'s own `lib/store.js` (schema 60) with a project and a workload receipt in it, then opened with this branch's `store.init()`, the call the server makes: it read versions 60 and 61, had the table, index and triggers, kept the project and the receipt, recorded a fact, and opened again unchanged. A standalone server was not started on it, though the plan named that: a server boot on this host reads the host's tmux and service state, and the lane keeps away from the installed services.

**Tests.** `test/workload-nudge-facts.test.js` and `test/workload-nudge-settings.test.js`, both new.

## 2026-10-09 — #2115: asking `scripts/apply-update.js` for help applied the update

<!-- prawduct: type=bugfix | scope=update-2115 -->
Chunk 01, the plan's only chunk. Branch `fix/2115-apply-update-help`, from `origin/main` `76988eed`.

Visual change: no

**What was wrong.** `main()` passed `argv.includes('--discard-tc-files')` to the applier and looked at nothing else, so every invocation ran the update whatever its arguments. `--help` is what a careful operator or agent types before a mutation, and here it was the mutation.

**What changed.**
- The script sorts its arguments with an exact-match parser. `--help` and `-h` print usage on stdout and exit 0. Anything else it does not recognize is refused with exit 2: the argument named on stderr, then usage, and nothing on stdout. That covers a positional word (`help`), a near-miss of the real flag (`--discard-tc-file`, `--discard-tc-files=true`) and an empty argument. A recognized flag beside an unknown one is refused whole. Help wins over everything else on the line.
- Neither path calls the applier, and neither opens the server-side log: the entry point asks the same `runsApplier` decision `main` does before it configures logging.
- A bare invocation and `--discard-tc-files` are unchanged: same call, same JSON, same exit codes 0 and 1.
- The README's manual upgrade path, ADR 0010 point 2 and the script's header say the same thing about flags and exit codes.

**Decided.** A usage error is exit 2 with an empty stdout, not a JSON refusal with a new `code`. Exit 1 keeps meaning "the applier answered, read the JSON", and ADR 0010 point 5 (a surface that reports refusal codes lists all of them) is left with the applier's own list, so the agent prompt in `public/session.js` needs no change.

**Not built.** The issue's "Consider requiring an explicit flag (`--apply` or `--yes`)" is a requirements question the issue does not decide. It is parked with the Operator, recommendation no: a bare invocation is what the README, ADR 0010 and the agent prompt teach.

**Checked by hand, on the chunk branch.** `--help`, `-h` and `--bogus` each run against the real script with `git rev-parse HEAD` read before and after: usage and exit 0, usage and exit 0, refusal and exit 2 with zero bytes on stdout, HEAD unchanged each time. A bare invocation was not run by hand.

**Not covered.** The script on the live install, which is read after a deploy and never run there. Node's own `ExperimentalWarning` for SQLite still reaches stderr on every path, help included, because the script requires the store for its base path; that predates this change.

**Tests.** In-process, with an applier that throws if it is reached. The help, refusal, parser and entry-point cases were run red on `76988eed` first; the two that pin the unchanged invocations passed there, as they should.

## 2026-10-09 — #2233: the isolation inventory could not read tmux when run by the server

<!-- prawduct: type=bugfix | scope=2233-launch-identity-containment -->

Found by the first read of `tc sessions isolation` on the live install, minutes after `c1ce788a5` was deployed. Branch `fix/2233-pane-reader-separator`, from `origin/main` `c1ce788a5`.

Visual change: no

**What was wrong.** `lib/tmux.js#listPaneStartCommands` asked tmux for each pane as name, tab, command. A tmux client that does not take its output to be UTF-8 prints every control and non-ASCII character as `_`. tmux decides that from `TMUX` (set inside a pane) and the locale. The server runs under launchd with neither, so the tab came back as `_` and no line could be split, every line became a session name with no command, no session was found under its real name, and the inventory read each one as `not-applicable` (`no_pane`) and printed "No live session needs relaunching". A false all-clear, on every install, for every engine.

**Why nothing caught it.** The reader's tests put a function in tmux's place, so they tested my model of tmux's output. The one run against a real tmux before the merge was made from this session's own pane, where `TMUX` is set and the tab survives. The boundary review found the same end state by another path (a failed tmux read) and that path was closed; this one arrives with tmux exiting 0.

**What changed.**
- The listing is asked for with `tmux -u`, so its output is UTF-8 whatever the caller's environment. Without it a start command holding a non-ASCII character (an executable under `/Users/josé/`) came back with `_` in its place and was judged as if it had been read exactly.
- The separator is a colon. tmux never lets one into a session name (it stores `a:b.c` as `a_b_c`, measured), so the first colon on a line always ends the name, and tmux prints it the same inside and outside a pane.
- A line that cannot be split (no separator, or nothing before it) makes the whole read `answered: false` (`unparseable`): every session then reads `unknown`. It used to be taken as a session with no start command.
- `test/tmux-pane-start-commands.test.js` gains a block that starts a real tmux server on its own socket and reads it with `TMUX`, `TMUX_PANE` and the locale removed (`LC_ALL=C`), as the server does, including a command with an accented path. It reproduces the defect on the old code. It skips with a reason where tmux is not installed. CI has tmux 3.4 and runs it.

**Measured (2026-10-09, tmux 3.6a).** With `TMUX` unset: `LC_ALL=C` or no locale prints a tab as `_` and `é` as `_`; `LC_ALL=en_US.UTF-8`, `LANG=en_US.UTF-8` or `-u` prints both as themselves. The first version of this fix named "outside a pane" as the cause and its test kept the developer's locale; the boundary review (`rev-20261009T210027Z-ca8ff37f`) questioned that, the measurement confirmed the review, and the test now pins the locale.

**Checked the same way.** Run with `TMUX` and `TMUX_PANE` removed against this host, the inventory now finds this session and the Project Master under their own names.

**Not covered.** tmux versions other than the three measured. The live proofs for #2233 are still owed.

**Tests.** The format, the first-colon split, three unsplittable listings and the two real-tmux cases were run red on `c1ce788a5` first.

**Review.** The boundary review found nothing blocking and three warnings that were one question: whether "outside a pane" was the real cause. It was not, and the second commit is the answer (see Measured above). The verification pass read the three as resolved. R-3 and R-4 were fixed in that same commit; the table shows them accepted because the ledger records a code fix only for blocking and warning findings.

**rev-20261009T210027Z-ca8ff37f** — 2026-10-09T21:02:31Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | Being discharged: the full suite runs on the committed tree and is recorded from its JUnit report before the PR is marked ready. |
| R-2 | warning | fixed | The real-tmux test removes TMUX and TMUX_PANE but keeps the developer's locale, so whether it reproduces the defect depends on LANG |
| R-3 | note | accepted | Fixed in the second commit (tmux -u, with an accented-path case against a real tmux); read as addressed by rev-20261009T210544Z-84feb18c. Recorded as an accept because the ledger takes a code fix only through a resolution. |
| R-4 | note | accepted | Fixed in the second commit (cleanup registered before the first new-session); read as addressed by the verification pass. Accept for the same ledger reason as R-3. |
| R-5 | warning | fixed | The separator fix names the pane as the variable; the variable is probably the client's UTF-8 flag, which leaves the start command itself open to the same rewrite |
| R-6 | warning | fixed | The recorded reason for the separator names 'not run from a pane' as the trigger; the real-tmux test removes only TMUX and TMUX_PANE and inherits the developer's locale |
| R-7 | note | accepted | Informational: the learnings corpus is local-only in the primary checkout, and the reviewer read it there. |
| R-8 | note | accepted | Informational: nothing to reconcile. |

**8 findings** (4 warning, 4 note) — accepted: 5, fixed: 3.

**rev-20261009T210544Z-84feb18c** — 2026-10-09T21:06:32Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | accepted | Being discharged: full suite on the committed tree, recorded from JUnit before the PR is marked ready. |
| O-2 | accepted | Measured, not only read: recorded in the change-log entry (tmux 3.6a), and the real-tmux test asserts it on every run where tmux is installed. |

**No findings** — a clean pass.
**2 observations demoted** — 2 answered. An observation gates nothing; answering one is optional.

**Found by CI after the first two commits: tmux 3.4 quotes differently.** CI runs tmux 3.4 (the earlier statement on this branch that CI has no tmux was wrong: it has, and it runs the real-tmux block). 3.4 writes a `$` that opens a variable name with two backslashes in front of it; 3.3a and 3.6a write one. TangleClaw's own PATH wrapper holds `$PATH`, so on 3.4 the wrapper was not recognised and an isolated Codex session would have read as not isolated. `unquoteStartCommand` now reads both forms. Measured on 3.3a (offline clean-room container), 3.4 (CI's log, printed by the test's own failure message) and 3.6a: a real backslash before such a `$` is four backslashes on 3.4 and three on the others, and both read back correctly; a backslash before a `$` that opens no name is written the same by all three. **Limit:** three versions measured. On a version that printed a name-opening `$` bare, a real backslash before `$NAME` would be read as `$NAME`; the only effect reachable through the inventory is a wrapper not being recognised, which reads not isolated.

**Also after the first review.** The real-tmux test takes its session names from `uniqueSessionName` and is listed in `test/tmux-session-names.test.js`'s guard, which the full suite failed on until it was; and its failure message carries the tmux version and the raw listing, which is how the 3.4 form was read.

**Later passes.** `rev-20261009T211422Z-11d366ea` (the session names) and `rev-20261009T214511Z-c6eedea3` (the 3.4 form): no findings in either.

**rev-20261009T211422Z-11d366ea** — 2026-10-09T21:14:53Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | accepted | Being discharged: the full suite is running on this tree and is recorded from its JUnit report before the PR is marked ready. |

**No findings** — a clean pass.
**1 observation demoted** — 1 answered. An observation gates nothing; answering one is optional.

**rev-20261009T214511Z-c6eedea3** — 2026-10-09T21:46:20Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | accepted | Being discharged: the full suite is running on this tree and is recorded from its JUnit report before the PR is marked ready. |
| O-2 | accepted | Accepted with the exposure stated: three versions measured (3.3a, 3.4, 3.6a). A command holding a dollar is refused by the Codex judgment after the wrappers are removed, so a misread can only make a wrapper unrecognised, which reads not isolated. The measured-versions limit goes in the change-log entry. |
| O-3 | accepted | Being done as a Markdown-only commit after the suite finishes, with the PR review's change-log warning: free of review cost. |

**No findings** — a clean pass.
**3 observations demoted** — 3 answered. An observation gates nothing; answering one is optional.

## 2026-10-09 — #2233: which running sessions were launched isolated (inventory and the carried fixes)

<!-- prawduct: type=bugfix | scope=2233-launch-identity-containment -->

#2233 Chunk 04, the last chunk of the plan, on the Operator's word ("get you working on the next chunk"). Branch `fix/2233-session-inventory`, from `origin/main` `0b512c3e9`. The issue stays open until the live proofs have run.

Visual change: no

**What changed.**
- **A read-only inventory of how each live session was launched.** `lib/tmux.js#listPaneStartCommands` reads every pane's start command in one tmux invocation. `lib/launch-isolation-inventory.js` joins the live session rows and the Project Master to those commands, takes TangleClaw's wrappers off with the inverses of the functions that wrote them (`lib/sessions.js#_withoutPathFloor`, `lib/bridge-handoff.js#unwrapLaunchCommand`) and asks the engine adapter. `lib/startup-control-codex.js#judgeRecordedCommand` answers for Codex. Verdicts: `isolated`, `not-isolated`, `unknown`, `not-applicable`.
- **A check that an end-and-relaunch took.** `verifyReplaced` says, for each earlier session id, whether it has ended and what its project's current session reads.
- **Surfaces.** `GET /api/launch/isolation` (`?replaced=`) and `tc sessions isolation [--replaced <ids>]`. The route answers the operator, the Master and a verified project session, and refuses anyone else through `lib/launch-binding-guard.js#refusalFor`, which is the floor's own refusal under an exported name.
- **The six items carried from the review of the diagnostics**, in the first commit: the per-launch Codex app-server no longer inherits `TMUX` and `TMUX_PANE` (`_serverEnvironment`); whoami reports a Master launch id tmux could not be asked about as `unknown`, and warns in the log for a stale binding; the pane check compares `TANGLECLAW_WORKSPACE_ID` too; two tests hold the pane's recovery sentence equal to the floor's and the guide's quoted line equal to what `tc whoami` prints; the exit-code headers name the local refusal.

**The sibling was re-derived, not copied.** `judgeLaunchCommand` is safe because it is handed the executable TangleClaw resolved and a version probe taken for that launch. Neither exists for a session already running. `judgeRecordedCommand` therefore takes the executable from the command's first word and, for an attached session, the socket, executable and version from the channel row written at launch. For `--no-daemon` nothing recorded the version, and probing now would describe the file on disk, not the running process. What stands in for it: before the launch judgment existed both Codex forms used the bare command name (`git show 343bb8273:lib/startup-control-codex.js`), and only the judged path writes a command that opens with the absolute path. The verdict's own sentence says the version is not re-checked. The two judgments share `_readArguments`, so a recorded command is read by the rules a new one is, and a test holds their reason codes equal for the forms refused as unparseable.

**Measured, and what it changed.** tmux prints a start command bare when it has no special character, otherwise in double quotes with `"`, `$` and a backslash escaped; it also writes a line break as `\n` and a tab as `\t` (throwaway tmux server, 2026-10-09). The reader undoes the first three and answers null for anything else. Run against this host's fleet, the inventory read the one live native Codex pane as `isolated` and two session rows with no tmux session as `unknown`. That second answer was wrong for the reader: tmux had answered, and there is no pane to be on a shared process. A session tmux has no pane for now reads `not-applicable` (`no_pane`); `unknown` is kept for a read that failed.

**Decisions.** The wrappers are recognised by shape (any bin directory the PATH floor accepts, any three quoted paths in the handoff), not by this install's paths, so a pane started before an install was moved is still judged. The pane check's added workspace id was traced first: it is written into a pane once, at launch, and nothing calls `tmux set-environment`. `tc sessions <unknown word>` now exits 1.

**Not covered.** The process now running in a pane; whether a tmux session named for a project is that project's current launch (no pane's environment is read here); a dashboard view. The live proofs (pane launches on Codex 0.156.1 and 0.157.1, a Master launch through its bridge wrapper, the dashboard's 409, and one real end-and-relaunch read with `--replaced`) need a deploy and the Operator's word each, and are not run.

**Tests.** `test/tmux-pane-start-commands.test.js`, `test/launch-isolation-inventory.test.js` and `test/launch-isolation-route.test.js` are new; `test/identity-diagnostics.test.js`, `test/tc-pane-identity.test.js` and `test/startup-control-launch.test.js` gain the carried cases. The carried cases were run red first. The inventory's tests were written before its code and first run after it, so they were red only in that the module did not exist.

**Review.** The boundary review found that a tmux failure other than a timeout or a spawn failure was read as an answered empty fleet, which the `no_pane` decision above then printed as nothing to act on: one blocking finding and two warnings, all the same defect. Fixed in the third commit: the pane reader answers an empty fleet only when tmux itself says it has no server, and a session with no derivable tmux name is `unknown`. The verification pass found the three resolved. R-2 and R-4 were fixed in that same commit and read as fixed by the verification pass; the table shows them accepted because the ledger records a code fix only for blocking and warning findings.

**rev-20261009T194749Z-aea188d8** — scope `2233-launch-identity-containment`, 2026-10-09T19:51:08Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | fixed | The inventory reads `not-applicable` (no action) for an absence tmux never reported: any non-zero tmux exit, and a session whose tmux name is not known |
| R-2 | note | accepted | Fixed in 976ca73c9 (renderIsolation prints the earlier-sessions block for an empty fleet, with a test); the verification pass rev-20261009T195435Z-7e23e824 read it as fixed. Recorded here because the ledger takes a FIXED for a code path only through a resolution, and resolutions cover blocking and warning findings. |
| R-3 | warning | fixed | A failed read can arrive at `no_pane`, which the inventory prints as nothing to act on |
| R-4 | note | accepted | Fixed in 976ca73c9 (the reader's comment now states the difference from _readSessionNames as deliberate, and why); read as fixed by rev-20261009T195435Z-7e23e824. Recorded as an accept for the same ledger reason as R-2. |
| R-5 | note | fixed-unreviewed | fixed in `docs/engine-guide.md` |
| R-6 | note | fixed-unreviewed | fixed in `docs/configuration-reference.md` |
| R-7 | note | accepted | The reuse is deliberate: one definition of which engines need a judgment and of each wrapper, shared with the launch path, and the inventory's tests run the real helpers. Making them public is a rename with no behaviour, better done with the server.js split in #2248. |
| R-8 | blocking | fixed | A tmux that exits with an error other than 'no server running' reads as an answered empty fleet, so the inventory reports every live session 'not applicable' and says nothing needs relaunching |
| R-9 | note | accepted | Informational: the learnings corpus is local-only in the primary checkout by design, and the reviewer read it from there. |
| R-10 | note | accepted | Informational: nothing to reconcile; #2233 stays open until the live proofs run. |
| R-11 | note | accepted | Informational: the records pass found nothing to change. |

**11 findings** (1 blocking, 2 warning, 8 note) — accepted: 6, fixed: 3, fixed-unreviewed: 2.

**rev-20261009T195435Z-7e23e824** — scope `2233-launch-identity-containment`, chunk 04, 2026-10-09T19:55:46Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | accepted | Being discharged, not waived: the full suite is running on this exact tree and is recorded from its JUnit report before the PR is marked ready. |
| O-2 | accepted | The verdict is right either way (no answer), and the case needs tmux to die without writing to stderr. Not worth a review round for a log field. |

**No findings** — a clean pass.
**2 observations demoted** — 2 answered. An observation gates nothing; answering one is optional.

## 2026-10-09 — #2049: close-out

<!-- prawduct: type=docs | scope=2049-fleet-recovery-clearance -->

#2049 chunk 6, the last chunk of the plan, by the Operator's word ("start chunk 06") to TC-RM01 under RM-LEASE generation 6. Branch `feat/2049-close-out`, from `origin/main` `39a68a8d`.

Visual change: no

**What changed.**
- **The panel script no longer publishes its route table.** `public/fleet-recovery-panel.js` set `tcFleetRecoveryRoutes` on the page and nothing read it (the PR #2252 review's first note). It is deleted, and `test/fleet-recovery-panel.test.js` now holds the script to the two names it publishes, by comparing the page's names before and after the script runs.
- **The user guide's Fleet Recovery section says what each "Back to the list" does.** The result's button reads the list again; the review's returns to the list as it was, without reading. The sentence used to say the first of both (the PR #2252 review's second note).
- **The user guide and `CHANGELOG.md` say what the result shows when the read-back fails:** what the clear itself re-read of each launch. The behaviour shipped in chunk 5's second commit; the two documents had not said it.
- `FEATURES.md`: the panel test's line names the new check.

**What was checked and left as it is.** `docs/configuration-reference.md`'s rows for `GET /api/launch/recovery-held`, `POST /api/launch/recovery-clear-batch`, `GET /api/launch/recovery-clear-batch/:batchId` and the single clear were compared with what the routes answer on a temp store: every answer field named, the refusals for a missing login, a missing sign-in, a missing CSRF token, an empty list, an unknown field, a non-number id, a duplicate and a list over the limit, the unknown batch id and the single clear of a cleared launch. Nothing differed, so the file is not edited.

**Every open criterion on #2049, run.** A script drove criteria 1 to 7, 9 and 10 through the real request handler on a temp store, then drove the real panel controller over those same routes. All of its checks passed, on `39a68a8d` before the edits above and again with them; the build plan's chunk 6 section holds the per-criterion result and the commit it ran on. It is the request handler in a process, not a listening server, and no browser. The panel in a browser is VRF-001's record.

**Not done here, by decision:** criterion 8 (wake/resume) is issue #2250 and criterion 11 (stop provenance) is issue #2249.
## 2026-10-09 — #2233: a session can ask what its launch identity is worth (diagnostics)

<!-- prawduct: type=bugfix | scope=2233-launch-identity-containment -->

#2233 Chunk 03. The plan's third chunk was split in two at this session's start: this entry is the diagnostics and every item carried from the earlier boundary reviews; the session inventory, the end-and-relaunch verification and the live cutover proofs are Chunk 04, on its own branch. #2233 stays open.

**The defect.** `GET /api/tc/whoami` resolved the project from the id a pane claimed and never read the launch id beside it, so `tc whoami` told a pane with a stale or foreign binding "You are a TangleClaw-managed session of project X". The pane learned otherwise only when a write was refused, and then from one of three wordings for the same cause: the write floor's, the launch sequence's, and the shared-docs resolver's.

**What landed.**
- `lib/shared-docs-access.js#resolveBinding`: the resolver without its operator test. `resolveAccess` calls it, so there is still one resolver. It exists because `resolveAccess` stops at the operator and so cannot say what a launch id is worth on a request that is also the operator's.
- `lib/launch-binding-guard.js#describeBinding`, `causeFor`, `recoveryFor`: one verdict (`verified`, `stale`, `unbound`) and one sentence per cause. `judge` and `describeBinding` share `_classify`, so the floor cannot admit what the report calls stale or the reverse. `lib/launch-sequence.js#_bindingRefusal` reads the same sentences for `SEQUENCE_SESSION_MISMATCH` and `SESSION_ENDED`. Codes and statuses did not change; the `error` text of these refusals did.
- `server.js`: whoami answers `binding` on the project and the Master answer (`_whoamiBinding`; a check that throws reads `unknown`). The service-token branch of the dispatcher has an error boundary of its own. The request log line of an admitted write carries `via`, and for a project `admittedProject` and `admittedSession` (`_admittedAs`).
- `lib/tc-verbs.js` and `bin/tc`: `renderWhoami` leads with a binding that is not verified and says "You claim" where it said "You are". Before any request, `bin/tc` compares the launch id, project id and role in its environment with the ones tmux recorded for its pane and refuses every verb on a difference (`PANE_IDENTITY_MISMATCH`, exit 2, nothing sent).

- `lib/engines.js#_medusaDiscoveryLines`, and the hand-kept copy in the tracked `CLAUDE.md`: the generated guide tells a session that a `tc whoami` which does not read `Launch binding: verified` means stop and report. `FEATURES.md` has the entry ("Launch identity diagnostics") and `docs/configuration-reference.md` ("Who may write") and `docs/engine-guide.md` describe the verdict and the pane check.

**Measured, and what it changed.** The plan's requirement for the pane check came from issue #2241 and was marked unverified. Measured on this host from a Claude tool shell: `TMUX_PANE` is set, `tmux show-environment -t "$TMUX_PANE"` answers, and the values equal the process environment. Read from the code, not run: on Codex's native path tools run in the per-launch app-server, which is started with the server's environment and has no `TMUX_PANE`. Reasoned, not run: a tool shell on an engine process shared between sessions inherits that process's whole environment, `TMUX_PANE` included, so it reads the other pane and finds agreement. So the check has three answers (`match`, `mismatch`, `cannot-check`), only `mismatch` refuses, and it does not catch the failure #2241 describes. The CHANGELOG entry, the engine guide and the JSDoc on `judgePaneIdentity` each say that.

**Test expectations that changed, and why.** `test/tc-cli.test.js`: the spawned Master whoami case ran with the role and no launch id and asserted "You are the TangleClaw Project Master". That pane is unbound, so it now asserts the claim wording and `LAUNCH BINDING ABSENT`; the receipt assertion is unchanged. The spawned project whoami case is given a real launch binding, so it still asserts "You are". The test files that spawn `tc` with the developer's environment passed through, and a test identity laid over it, were refused by the new check inside a tmux pane, correctly. They now build that environment through (as does one `git` spawn in `test/checkout-state.test.js`, which did not need it and is harmless) `test/_tc-env.js#outsidePane` (`git grep -l outsidePane test` lists them). CI has no tmux and would not have shown this.

**Carried items, all met here.** The service-token read's error boundary and its test; the wrap-in-flight case through the floor (it passed before any change: it records a behaviour that was promised and untested); the admitted-identity log fields; the longer contracts list and the reporter credit in `CHANGELOG.md`; the `docs/openclaw-setup.md` pointer; pointers to "Who may write" from the control-state, coordinator-rotation, operator-bridge and eval-audit route tables; the history sentences removed from two test comments.

**Not verified.** The new tests were written before the code; the `describeBinding`, `resolveBinding` and `tc` pane-check tests were not run red, since they call functions that did not exist. The launch-sequence wording test and the dispatcher tests were run red. Nothing here was run against a deployed server: the live install runs the previous commit, where the new `tc` reads "Launch binding: not reported by this server".

**Not covered.** The pane check's blind spot above. A signal that does not travel with the inherited environment (the tool shell's working directory against the claimed project's path) is proposed to the Operator as its own issue and is not built.

**Review (rev-20261009T161447Z-34ebf192, boundary, three reviewers): 0 blocking.** The two warnings and four of the notes are fixes that ride Chunk 04's first commit and are written in the build plan's section 6d.

**rev-20261009T161447Z-34ebf192** — scope `2233-launch-identity-containment`, chunk 03, 2026-10-09T16:18:49Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | Real, and not reachable under launchd: it needs the server started by hand from a TangleClaw-launched pane. Fix (strip TMUX and TMUX_PANE from the environment of a process the server spawns to carry a launch identity, with a test) rides Chunk 04's first commit; written in the build plan section 6d, which is the chunk that rehearses a native Codex launch. |
| R-2 | note | accepted | A test tying the guide's quoted literal to renderWhoami rides Chunk 04's first commit; written in the build plan section 6d. |
| R-3 | note | accepted | Accepted as designed and recorded as a decision in the plan: the guard answers three states, the report adds unknown and unreported, and each is tested at the renderer. Aligning master-unverifiable with NOT CHECKED rides Chunk 04's first commit; written in the build plan section 6d. |
| R-4 | note | accepted | One owner for the stale recovery sentence is not possible by import (lib/tc-verbs.js stays free of server modules); a test holding the two literals equal rides Chunk 04's first commit; written in the build plan section 6d. |
| R-5 | note | accepted | The exit-code headers in bin/tc and lib/tc-verbs.js gain the local refusal; doc-only, rides Chunk 04's first commit; written in the build plan section 6d. |
| R-6 | note | accepted | Not added on this branch; the mirrored Global Rules are the Operator's to move. |
| R-7 | warning | accepted | One log.warn for a stale whoami verdict rides Chunk 04's first commit; written in the build plan section 6d. |
| R-8 | note | accepted | Left out deliberately until someone traces whether a workspace id may legitimately change within a session; the question is in the plan section 6d for Chunk 04. |
| R-9 | note | accepted | No action: the learnings tree is gitignored and exists only in the primary checkout. |
| R-10 | note | accepted | No action. |
| R-11 | note | accepted | No action. |

**11 findings** (2 warning, 9 note) — accepted: 11.

## 2026-10-09 — #2049: two defects in the fleet recovery panel, found by using it

<!-- prawduct: type=bugfix | scope=2049-fleet-recovery-clearance -->

#2049, a fix to chunk 5 after it merged (PR #2252, `de59154b`), by the Operator's word ("fix them as recommended") to TC-RM01 under RM-LEASE generation 6. Branch `fix/2049-recovery-panel-fold-and-disabled`, from `origin/main` `de59154b`.

Visual change: yes

**How they were found.** The Operator had the builder run operator verification VRF-001 on the live install, in their signed-in browser, on a launch held for the purpose. Checks 1 to 6 passed. Two things were wrong that no test and no still screenshot had shown.

**What was wrong, and the fix.**
- **An open evidence fold closed on every redraw.** The panel redraws its markup when a checkbox is ticked, and a `<details>` drawn fresh is closed. An operator who opened "Work that may have been queued or in flight" and then ticked a launch lost their place. The controller now remembers which launches' folds are open (`state.unfolded`, set by `fold(key, open)`) and draws those open. The mount listens for `toggle` in the capture phase, because `toggle` does not bubble. A fold is forgotten when its launch leaves the list or its recovery revision moves, as a selection is.
- **A disabled button looked like an enabled one.** `.btn` has no disabled style on this page, so "Review 0 selected" was drawn in the same green with a pointer cursor. One rule, scoped to the panel, dims a disabled button and changes the cursor.

**Root cause.** Both are facts about a rendered, interactive page. The chunk's verification was string tests of markup plus still screenshots of states set up by script; neither presses a control and then looks. The headless harness even opened a fold by script after the last redraw, so it could not have shown the first defect.

**Decision.** The disabled style is scoped to `.fleet-recovery-panel`, not added to `.btn`. A global rule would change every dashboard button, and the UI freeze exception covers this panel only.

**Verified, and not.** Three guards were checked by breaking them (a fold never drawn open, the toggle listener not capturing, a fold kept across a moved revision); a test failed for each. Rendered in headless Chrome with a real toggle and real clicks: the fold stays open through a tick and Select none, and the disabled Review button is dimmed. Not yet seen on the live install: that needs a merge and a deploy.

## 2026-10-09 — #2049: the fleet recovery panel

<!-- prawduct: type=feature | scope=2049-fleet-recovery-clearance -->

#2049, chunk 5 of the plan, by direct Operator assignment to TC-RM01 under RM-LEASE generation 6. Built on branch `feat/2049-fleet-recovery-panel`, from `origin/main` `faafb7da`. The Operator granted the exception to the UI freeze (A24) for this panel only.

Visual change: yes

**What landed.** `public/fleet-recovery-panel.js`, opened by a new **Recovery** button in the dashboard header. It lists every launch held in operator-cleared recovery with its evidence, takes a selection of all or some, shows a review of exactly what will be sent, sends one batch clear, and shows one outcome per launch with the batch read's observation beside it. `public/` and tests only: no route, no store change, no migration.

**Decisions.**
- The panel is its own script with a controller that touches no DOM, so the tests run the shipped code against the real request handler. It follows the Operator Bridge panel's shape.
- It does not decide who may use it. It calls the fleet read and shows the server's answer; on an install with no login that is the refusal and no control. A second copy of the gate rule in the page could drift from the server's.
- No count badge on the button. A badge would call the fleet read on every dashboard load, and an install with no login would log a refused read each time.
- A selection is keyed on the launch and its recovery revision. A refresh that finds the revision moved drops it.
- The review step is the confirmation. No browser dialog is used.
- The stored cursor is worded "launch step cursor". "First unacknowledged step", which the plan had carried as an assumption from chunk 4, reads as a claim about acknowledgement.
- Outcomes that left a launch alone are amber, a failure is red, a clear is green, and each is worded. An outcome the page does not know is shown by its code and never as a clear.
- It escapes with the page's `tcEscapeHtml` and adds no escaper (#1605).
- Secondary lines use opacity, not `--text-muted`, which is under the 4.5:1 contrast floor on the dark theme. These lines are the evidence the operator decides on.

**Docs corrected.** Four unreleased `CHANGELOG.md` sentences from chunks 1 to 4 said no page existed for the fleet read, the batch clear, the batch read and the clearance record. The first three now name the panel. The fourth now says what is still true: no page lists a clear made on its own.

**Not in this chunk.** A list of past batches, stop provenance (#2249), the wake action (#2250), #2178. #2049 stays open for the close-out chunk.

**Verified, and not.** The tests drive the real request handler on temp stores. The panel was rendered in headless Chrome against the real stylesheet with scripted answers, in the dark and light themes and at 500 pixels wide, and the screenshots were read. It was not run in the dashboard of a running install, and no person has used it: the operator verification entry is queued for that.

## 2026-10-09 — #2049: a signed-in operator reads a batch clear back, with what each launch says now

<!-- prawduct: type=feature | scope=2049-fleet-recovery-clearance -->

#2049, chunk 4 of the plan, by direct Operator assignment to TC-RM01 under RM-LEASE generation 6. Built on branch `feat/2049-batch-observations`, stacked on `1c233fd9` (PR #2247, chunks 2 and 3), which contains `origin/main` `a8610e72`.

**What landed.** `GET /api/launch/recovery-clear-batch/:batchId` and `lib/launch-recovery-batch.js#readBatch`. The answer is the batch as recorded (header, each item's outcome, the clearance of each cleared item) and, beside each item, an observation of its launch read at `observedAt`: stored recovery, whether it is still blocked, the step cursor, whether a READY attestation is recorded, and the session's stored status. No migration.

**Decisions.**
- Every item is observed, not only the cleared ones. The plan said "for each cleared launch"; a refused item's launch is the one the operator most needs to look at again, and the batch write already re-reads every item. The cost is one launch read and one session read per item, at most 100.
- The two operator reads that span projects (`recovery-held` and this one) share one check, `_requireOperatorRead`, extracted from the held route. A second copy of the gate ladder could drift from the first, which is the reason the batch write reuses `_requireOperatorWrite`. The held route's answers and log lines are unchanged and its tests pass untouched.
- Any signed-in operator may read any batch. The answer names who sent it. An install has one operator role, so there is nobody to hide a batch from.
- The observation reuses the fleet read's three states (`recorded`, `none-recorded`, `unavailable`), so a client reads "holds nothing" and "could not be read" one way in both operator reads.
- The session's status is read apart from the launch, so an unreadable session row does not hide what the launch row says.
- A batch that stopped part-way is reported by position (`unrecordedIndexes`). The header stores no item ids, so the launches at those positions are not named and not guessed.
- The batch write's own re-read (`recoveryNow`, `recoveryRevisionNow`, `stillBlocked`) is left as it is. Both now find the launch through one function, `_launchAsNamed`.

**What "attested READY" and "still at a prompt" became.** The issue asks which sessions attested READY and which are still at a prompt. `attestedReady` is the first, from the launch row. Nothing durable records what a pane is showing, so the second is not answered and the answer says nothing about it; `cursor` and the absence of a READY attestation are what is known.

**Not in this chunk.** The fleet recovery panel (it needs the Operator's exception to the UI freeze), stop provenance and the wake action. #2049 stays open.

**Not verified.** Nothing was run against a live install or a copy of a real database. No client calls this route yet. The tests drive the real request handler against temp stores.

## 2026-10-08 — #2049: a signed-in operator clears several launches in one request

<!-- prawduct: type=feature | scope=2049-fleet-recovery-clearance -->

#2049, chunk 3 of the plan, by direct Operator assignment to TC-RM01 under RM-LEASE generation 6. Built on `origin/main` `395ebcec` (Builder2's #1937 chunk 01), merged into the branch first as `636257af`.

**What landed.** `POST /api/launch/recovery-clear-batch` and `lib/launch-recovery-batch.js`. A request names one to 100 launches by exact binding; each goes through `clearOneLaunch`, the single clear's own decision, and gets one of eight outcomes plus a re-read saying whether the launch is still blocked. Schema v60 adds `launch_recovery_clear_batches` (the header, written before any item is decided) and `launch_recovery_clear_batch_items` (one outcome per item), both append-only by trigger, with a trigger that refuses an item whose batch has no header.

**Decisions.**
- The route reuses `_requireOperatorWrite` and then refuses any proof other than `operator-verified`, as the reconciliation read does. One proof for every operator write, so it cannot drift; the cost is that an open install's refusal is reached after the open-install checks.
- A `cleared` item outcome is written inside `clearRecoveryAsOperator`'s transaction, not afterwards by the batch. The batch's record can then never say less than what was cleared under it, and `recordItem` refuses the word `cleared` so it cannot be written without a clear.
- The header is never updated. A batch that stops part-way reads as a header naming more items than have rows. An append-only table cannot carry a "completed" stamp, and the shortfall says the same thing.
- The archived rule is enforced by the batch, not moved into `clearOneLaunch`. A93 says an archived project is not batch-clearable; moving it would also have taken the single clear away from an archived project's own panel, which nobody asked for.
- Duplicates are two items naming one launch or one session, whatever else they say, because a session has one launch.
- Ids must be JSON whole numbers. The single clear coerces with `Number()`; a batch refuses `"3"` so that a request is applied exactly as sent or not at all.
- No client idempotency key. Each request is its own batch, and a repeat answers `already-clear` for what the first one cleared.

**Carried from chunk 2's review, fixed here.** The compare-and-set is now private to `lib/store.js`. Public `clearRecovery` takes `agent-reconciled` only and throws on the two operator words, and it no longer accepts a `clearedBy`. The test call sites that cleared with an operator word moved to `clearRecoveryAsOperator`; none of their assertions changed.

**A chunk 2 test changed, and it got stricter.** "records the batch a clear belongs to" cleared under a batch id with no header. That is now refused by the table, so the test records the header and names each item.

**After the chunk's review.** `origin/main` moved to `a8610e72` (#2233's caller check) and was merged in as `64e875e4`. `1c233fd9` then moved three batch tests onto that check, named all four no-login refusals in the API reference and pinned the two that had no test. Chunks 2 and 3 went up as PR #2247 at `1c233fd9`.

**Not in this chunk.** A route that reads a batch back, the fleet recovery panel (it needs the Operator's exception to the UI freeze), stop provenance and the wake action. A93 says an API-only batch is not the feature: #2049 stays open.

**Not verified.** Nothing was run against a live install or a copy of a real database. The tests drive the real request handler and the real migration against temp stores.

## 2026-10-08 — #2049: an operator's recovery clearance is kept as a permanent record

<!-- prawduct: type=feature | scope=2049-fleet-recovery-clearance -->

#2049, the first chunk after PR #2190 (chunk 2 of the plan), by direct Operator assignment to TC-RM01 with no ProjectManager or Architect coordinating. The plan and its chunk map are in this checkout's build plan; the rulings it follows are the Architect's A93, A96 and A152.

**What landed.** Schema v59 adds `launch_recovery_clearances`: one row per operator clearance, refused on update and delete by trigger, never pruned. `store.launchSequences.clearRecoveryAsOperator` runs the existing compare-and-set and inserts the row in one transaction, and `clearOneLaunch` now clears through it, so the single clear route records every clearance with a null batch id. The row copies the launch's stored preflight record as text. `store.recoveryClearances` reads one launch's record or a batch's.

**Decisions.** Only operator clearances are recorded: a session's advisory reconciliation still clears through `clearRecovery` and writes no row, and the table's CHECK admits the two operator words only (A152: an advisory reconciliation is not an operator clearance). No foreign keys, so a row outlives its project and never blocks deleting one. One row per launch, held by a unique index, because a launch's recovery never returns to `required` once cleared. The table also refuses a batch id on an unverified clearance, which is A93's rule that a batch never inherits the open-install path, stated where a later batch route cannot forget it.

**Behaviour change to the single clear.** A clearance record that cannot be written rolls the clear back and the route answers `500`. Before this the clear had no second write that could fail.

**Not in this chunk.** The batch route, the batch header and per-item outcomes, any route or page that reads the record, stop provenance and the wake action. Clearances made before v59 get no row.

**Not verified.** Nothing was run against a live install. The tests drive the real request handler and the real migration against temp stores.

## 2026-10-08 — #2233: a request that changes state must say who is asking (I1)

<!-- prawduct: type=bugfix | scope=2233-launch-identity-containment -->

#2233 Chunk 02 of three, under Architect rulings A163 R11 and R12 and the PM's relays of the I1 rulings. Built on the branch after a true merge of final main `feef3115c`; the Chunk 01 commits were not rewritten. The release hold is unchanged, and the reporter's route is still not established.

**The defect.** Each mutating route decided for itself whether to check its caller, and more than half did not. A request with no launch binding, one whose session had ended, or one from a session a newer launch of the same project had replaced could still lease ports, send Medusa mail, type into a pane, change configuration and reach setup and credential routes. With a login armed, a local process that did not look like a browser passed the login gate as a machine client and reached those handlers unidentified.

**What landed.** `lib/launch-binding-guard.js#judge`, called in `server.js#handleRequest` after the service-token gate and before the body is parsed. It reuses the one caller resolver (`lib/shared-docs-access.js#resolveAccess`) and adds the comparison that resolver does not make: the verified session must be its project's current active session. Refusals are `403 LAUNCH_BINDING_REQUIRED` and `403 LAUNCH_BINDING_INVALID` with a reason. It establishes who is asking and nothing more: every route's own check of what that caller may touch still runs, and the caller's project is deliberately not required to equal the route's target, so a coordinator's cross-project wrap and command still work.

**Exceptions, each exact and each ruled.** Sign-in, sign-out, recover and first-account creation; `tc start next` and `ready` (which must answer a launch still being recorded) and the rule-receipt hook; audit ingest, which proves its connection's audit secret in its handler, now in constant time and over every connection. Bridge routes are excepted only for the Master's and the chat helper's own credentials (`lib/bridge-api.js#provesOwnPrincipal`, a closed list); my first wiring marked every bridge route, which let the session candidate route skip the current-session comparison, and the read-only trace that the PM ordered is what caught it. A verified service token is a principal on the five port writes only, and only while that gate is on. An ended launch may repeat its own finalize, and only for a session that finalize path itself ended.

**Contracts that changed, by ruling.** An unidentified caller on a write now gets the floor's code where it used to get a route's own (`PROJECT_BINDING_REQUIRED`, `SHARED_DOCS_BINDING_REQUIRED`, `ROTATION_BINDING_REQUIRED`, `WORKLOAD_BINDING_REQUIRED`, `OPERATOR_ONLY`, `OPERATOR_REQUIRED`, `423 CONTROL_CALLER_UNATTRIBUTABLE`, and a `401` from routes that checked a login themselves). Those expectations were changed; in each file the route's narrower refusal is still asserted for a caller whose binding verifies. Those route-level branches are left in place as a second check. Three behaviours are gone rather than moved: an unbound normal Medusa send was accepted and recorded with an unverified sender (now refused; the assertion on `sender.verified === false` was removed with the behaviour); setup and Caddy-credential writes were reachable by a bare loopback request while the gate was `account-required` (now refused; the real flow of create account, sign in, change the credential is tested instead); and the audit heartbeat accepted any caller (now refused; #2239 tracks its credential).

**One response whose positive test is unreachable under this policy (Architect ruling A163 R19).** `POST /api/setup/complete` answering `ingress.protection: 'unchanged'` needs a stored Caddy credential, no TangleClaw account, and a request that supplies no login. Its two tests reached it as a bare machine request, which is now refused. A signed-in operator cannot reach it: an account existing makes the post-save gate `armed`, and the handler then answers `'account'`, which the real-flow tests assert. Read from the handler, the only caller left is a browser-shaped request while the fallback marker is honoured, on a first-run or a completed install; the ruling does not accept the fallback as operator proof for a test, so no positive test was restored. The response and its warning are kept as written. The former assertions are unreachable under current policy, not passed. What is tested: a bare request (403) and a session-less browser (401) are refused before anything is saved.

**Fixtures.** The red-first run with the guard wired and no fixture touched failed across the suite; every failure traced was the guard refusing a request, none a handler fault. Repairs give each request the identity it stands for: the operator's dashboard on an open gate, a signed-in account session with its CSRF token on an armed one (`test/_shared-docs-callers.js#signInOperator`), or a bound session (`bindProject`). Three tests that would have passed only because their request was refused were given real outcome assertions.

**Guides.** The port guide, the generated Medusa guide, the prime's switchboard section, the Master's Medusa instructions and the `tc ports` hint showed writes without the launch headers and are corrected. So are both forms of the wake nudge (`lib/medusa-wake.js#_nudgeText`: the session form now says each raw write needs the launch headers, the Master form names its role and launch headers), the table and shell-comment forms of the Medusa guide, and the docs that showed a write with no caller: the API reference gains a "Who may write" section and a note under Ports, and the fleet runbook's lease step, the Medusa delivery doc, the audit heartbeat entry and the two `curl` examples in the OpenClaw setup guide are corrected. A session launched before this change keeps the old text until it is relaunched. Not corrected here: the port guide copy inside this repo's tracked `CLAUDE.md` is generated, and is rewritten from `data/porthub-guide.md` at the next launch rather than by hand.

**A flake found by the boundary run, fixed in the test.** `test/api-wrap-stream.test.js` ("logs a client that goes away") gave the server a fixed 50 ms to see a closed stream before ending the run, and failed once in a full run on a loaded host while passing alone. It now waits for the log line itself, within a bound. The assertion is unchanged.

**After the first CI run on the PR.** CI was red on one case that is green on every developer machine: `test/api-setup-https.test.js`, "caddy mode: prepare on an ungated install is refused". With the login off in caddy mode, whether the gate stands down is read from the Caddyfile through `caddy adapt`. The CI runner has no Caddy, so the suite's hand-written file was unreadable there, the gate enforced, the operator fixture signed in, and the install the case calls ungated was gated. The case now parks the Caddyfile for its duration (no file is no door on every host) and asserts the gate is down before it asserts the refusal. Reproduced locally by running the file with Caddy off `PATH`, red before and green after. In the same commit, a boundary-review warning is fixed rather than carried: the floor's call in `server.js#handleRequest` sat outside the handler's error boundary, so a store read that threw left the write unanswered and the socket open. It is now answered `500 INTERNAL_ERROR` and refused; `test/launch-binding-dispatch.test.js` holds it (the request hung before the fix).

**Soak harness: not in this change.** `lib/soak` sends its writes with the service token and no caller identity, so against a guest running this change its launches, kills, commands, wraps and Medusa sends are refused. It may fail closed, and this change makes no claim that it is compatible. A partial repair (an actor on every write, the token scoped to the port registry, an operator sign-in for admin calls) was written here, then moved out by Architect ruling and preserved on its own branch for #2240, which owns the repair and its proof. No soak run is a gate for this change.

**Not covered.** While the login gate stands down (an install with no login, or an honoured fallback), `lib/shared-docs-access.js#_isOperator` recognises the operator by request shape or the dashboard's client header, and is asked before the launch binding, so a process that claims to be the dashboard passes the floor. That is the resolver's existing, documented rule, read from the code and not executed here; the floor adds attribution for honest callers there and authentication only where a login is armed. A conversation that presents another live session's valid binding is admitted as that session. Whether the real dashboard identifies itself on every write was read from `public/` and not checked in a browser. Nothing here was run against a live install, a real Caddy or a real guest.

## 2026-10-07 — #2233: a Codex launch that cannot be shown isolated does not start (S3)

<!-- prawduct: type=bugfix | scope=2233-launch-identity-containment -->

#2233 Chunk 01 of three, under Architect ruling A163 R3 + R4 and PM dispatch. Plan: `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1/.tangleclaw/plans/2233-launch-identity-containment.md`. Containment only: the reporter's route is not established and the release hold is unchanged.

**The defect.** Both launch sites (`launchSession`, `ensureMasterSession`) fell through to the bare `codex` command whenever no isolated command could be built: an unlisted version, a failed probe, an adapter hook that threw. A bare Codex can be served by a background process another launch started, with that launch's TangleClaw identity.

**Root cause.** The hardening was a best-effort rewrite with a permissive fallback, and nothing looked at the command that actually ran. Three further gaps were found while re-deriving it: the probed executable and the executed one could differ (the pane ran a name); the legacy hardening read a module-global version cache other probes write; and the adapter was found through a profile capability block.

**What landed.** `judgeLaunchCommand` (pure) and `isolateLaunch` in the Codex adapter; `_isolatedLegacyLaunch`, `_judgeLaunchIsolation` and `_isolationRefusalMessage` in `lib/sessions.js`; both launch sites judge the engine command immediately before tmux and refuse with `LAUNCH_ISOLATION_UNVERIFIED`; both routes map it to 409. The pane command is pinned to the probed executable's full path on the native and legacy paths. No schema change, no override.

**Architect ruling on the plan (PM relay `8577c3c8`), applied before the head.** A1 and A3 approved. A2 vetoed as written: a launch that names Codex must refuse when no registered judge applies, so `_engineNeedingIsolation` recognises Codex independently of the adapter registry and a missing, hook-less or disclaiming adapter is `no_judge`. The native allowance also requires the handle's version to be in the profile's `verifiedVersions`. Repeated, combined, `=`-form and `--daemon*` flags are refused as unparseable.

**Tests whose contract the ruling reversed.** The existing cases that asserted the old fallback, an unverified version launching the bare command (one in `test/startup-control-launch.test.js`, four parameterised in `test/master.test.js`), are replaced by their inverse, with a comment citing the ruling. Three launch fixtures that used 0.150.0 only to reach the legacy path now use 0.157.1, which reaches the same path and still launches; their assertions are unchanged.

**Cumulative review `rev-20261008T045207Z-78ab04fd` on `5598ee450`: 1 blocking, 5 warnings, fixed in one pass.** Blocking: the Codex install command TangleClaw offers installed the newest Codex, which this change refuses; `data/engines/codex.json` now pins `@0.156.1`, the version refusal gives the same command, and a test holds the two equal and the pinned version to both verified lists. Warnings: the recovery sentence is now per reason (only a version reason says to install); the shell-character denylist is replaced by a per-word allowlist; the superseded builders (`_legacyStartupCommand`, `_hardenedLegacyLaunchCommand`, the adapter's `legacyLaunchCommand`, and its unit test) are deleted, since for Codex their output could only be refused and for every other engine they returned their input; the pinned command forms were run against the real codex-cli 0.156.1 in a real shell with `--version` appended (plain path, quoted path with a space, mode flags plus `--no-daemon`, `--remote`), each accepted, and an unknown flag rejected, which starts no session. Notes taken: one recognition of Codex, made at the launch site and handed to the adapter, so the two cannot disagree; the Restart button classifies the refusal as nothing-started; the refusal log lines carry the reason and an allowed launch logs which isolation it got. Notes not taken: the landing page's six-second toast, and the extra synchronous version probes (#2231).

**Architect's conditions on the resolution (PM relay `fd1a5a7a`), applied in the final commit.** The scope above and the `@0.156.1` pin are approved. A refusal on the `--remote` path now has its own code, `native_version_unverified`, and its recovery names only the profile's native `verifiedVersions`, so 0.157.1 (verified for `--no-daemon` alone) is never offered where it would be refused again; with no native version on record it says no Codex version is the remedy. A launch identified as Codex whose executable is not named `codex` is refused as `executable_unverified` and never probed (Architect ruling relayed in PM `e933f90f`): passing the launch site's recognition to the builder had made such a wrapper eligible for `--no-daemon` on its `--version` output alone. The `PLAIN_ARGUMENT` comment no longer claims `~` is allowed. `docs/engine-guide.md` gains a compatibility section: both verified lists, what is refused, the pinned install, already-running sessions, operator cutover, unsupported paths, no override.

**Second cumulative review `rev-20261008T051218Z-ad45802c` on `c29590d75`: 1 blocking, 3 warnings.** Blocking: the wrapper refusal broke the four suites that launch Codex on a made-up path not named `codex`, and I had committed without rerunning them, the same miss as the first full run, one commit later. `test/_codex-launchable.js` now owns what Codex resolves to (`detectWithCodex`), the four suites use it, and the affected suites were enumerated by what they call (`launchSession`, `ensureMasterSession`, a request handler) rather than by file name. Also fixed: a comment in the Master ensure route had been split from the code it explains; a builder that throws is refused as `judgment_failed`, not as a version problem that tells the operator to reinstall Codex; an allowed Master launch logs its isolation; one misleading sentence removed from the engine guide. Not fixed, recorded for the owner of #2188: the argument allowlist admits no quote, and `lib/engine-models.js#modelArgv` returns a quoted model id that nothing passes to a launch yet.

**Architect hold A163 R9 on `c29590d75` (PM relay `802867dc`), fixed.** `launchSession` prepared the native channel before judging, so a Codex-identified wrapper that reported the natively verified version was spawned as an app-server and then killed; "Nothing was started" was false for it, and the version probes had run the wrapper too. `_admitEngineExecutable` and the adapter's `admitExecutable` now decide from the path alone, before any probe or spawn, at both launch sites; a missing or throwing admission check refuses a Codex launch without running even the real executable. Tests require zero probes, zero spawns, zero kills, no session row and no channel row for a wrapper on the native path, the fallback path, an unverified version, relaunch, and identification by profile alone.

**Fixtures and assertions that moved with the contract.** Four suites that launch Codex on a made-up executable path and are not about Codex (`test/startup-prompt-api.test.js`, `test/launch-sequence-settings.test.js`, `test/launch-mode-settings.test.js`, `test/silent-prime-drop-warning.test.js`) now use `test/_codex-launchable.js`, which answers the version probe as a launchable install would. Two assertions changed shape with it and neither is weaker: `test/master.test.js` asserts every probe asks the launch's executable (the launch now probes more than once) instead of exactly one probe; `test/startup-prompt-api.test.js` asserts the whoami detail for the stand-in version first, then the original unknown-version wording after emptying the cache.

**Verification.** Each mechanism was reverted in turn and at least one test went red for every one, bracketed by green baselines: the judgment ignored at each site, the cache read, each pin, throw-allows, no-judge-allows, the server left running, each route mapping, the probe-path, socket, native-version, ambiguous-flag, `--` and shell-character checks, each Codex sign, path quoting, and a credential issued before the refusal.
## 2026-10-08 — #1937: the Launch readiness panel states a project's recovery mode and lets the operator choose it

<!-- prawduct: type=feature | scope=1937-recovery-mode-panel -->

#1937 Chunk 01, assigned by the Operator directly. Plan: `.tangleclaw/plans/1937-recovery-mode-panel.md` in the Builder2 checkout.

**What was missing.** Five merged PRs built the server side: the operator's decision is recorded, advisory is the default where the login is in force, and `GET /api/launch-sequences` reports the project's mode, source, gate state, discrepancy and decision. The panel passed only `sequences` to its renderer and dropped the rest, and nothing under `public/` sent `launchSequence.recoveryMode`. The setting existed and no operator could see or set it without `curl`.

**The change.** `public/ui.js` renders the mode above the launch rows (who clears a recovery under it, why the project is in it, the decision on record, any discrepancy) and a two-option control that saves through the existing operator-only `PATCH /api/projects/:name`. No server route or field was added: the plan's first assumption held. `lib/launch-sequence.js#_operatorHeldAction` adds one sentence pointing at the panel for future launches, in the two gate states whose action is already the panel.

**Decisions taken while building.**
- The control is offered from what `GET /api/auth/me` answers, not from `projectRecoveryGateState`. The first is the request-side answer the route itself reads; the second is the launch-side probe. Driving the real route in every state in `GATE_STATES` showed it takes the dashboard's save in `armed` (signed in), `open` and `fallback`, and refuses before any route in the other three, where the panel cannot load either. One predicate covers it: no control for a page that is not signed in while the gate enforces.
- The save's outcome is kept beside the readout, not in the modal's status line. That line hides after three seconds, and the outcome says when the choice takes effect and what a failure left behind.
- On an install whose login is not in force the control is offered, because ADR 0017 R3 says an operator's decision stands in every gate state. The advisory option says nobody can read a reconciliation back there, which a test holds against the readback route.
- A held row now says "this launch froze" a mode where it said "this project is in" one. The old wording was wrong whenever the project's mode had changed since the launch.

**Found, not fixed here.** On an install with no login the decision is recorded with `decidedBy: "operator"`, although ADR 0017 R3 describes that record's provenance as `open-install-unverified`. The panel words the record as a request with the dashboard's shape wherever the login is not in force. The stored value is a server-side change outside this chunk and is filed as #2244.

**A plan detail that was wrong.** The plan named `docs/recovery.md` for the documentation. That file is about getting back into TangleClaw's login. The recovery mode is documented in `docs/user-guide.md` and `docs/configuration-reference.md`, and those were updated.

**A test whose assertion moved.** `the refresh cycle tells the renderer whether the install has a login` compared the renderer's whole options object with `{ noLogin }`. The options now also carry the project's mode, so it reads `noLogin` by name; the new field has its own tests.

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

**Architect A160 R16: the Project Master too.** The Critic's sweep of every path that fetches a profile and then starts or types into an engine found one that R15 did not reach: `master.ensureMasterSession` checked only that the fetched profile was truthy before detecting the engine, building the launch command with the profile's environment and creating the pane, and the settings route accepted `master.engine` on the same truthiness. Bounded (the Master launch types nothing, and its commands go through the send-time check), but it is the same trust. `identify` now stands in both places; a running Master's early return is untouched. A route-level test pins the 409 for a project launch.

**R17: a lockout I introduced in R16, and the Master's unchecked send.** The Critic, asked directly, confirmed that my R16 settings check ran on the MERGED Master settings, so a stored engine whose profile had lost its id made every partial patch answer 400, including the Master bar's access toggle, which sends `accessLevel` alone: write access could not have been revoked. Expected: refuse choosing such an engine. Actual: refused changing anything while one was stored. Root cause: I put the test where the existing "is a configured engine" check was, without asking what else that merged object is validated for. It now runs only when the patch names `engine`; the start-time refusal is the gate for one already stored. The same review found that `injectMasterCommand` caught a failure to resolve the Master's engine and sent with no engine named; the Master has no session row, so that send was checked against nothing, and the resolution fails whenever any installed profile file does not parse. It is now refused (`MASTER_ENGINE_UNRESOLVED`); the test that pinned the old delivery is reversed with a note. I left the older "is not a configured engine" check where it was, on the merged settings, and reported it as a pre-existing lockout; the Architect and the PM ruled it the same release blocker (R18, R19), and the whole engine block (lookup, existence, identity) now runs only when the patch names `engine`. A stored engine whose profile is missing, holds `null`, or does not parse no longer blocks an `accessLevel`-only or `autoStart`-only patch; naming such an engine answers 400, including the unparseable case, which used to throw out of the validator.

**Incident, 2026-10-08 08:01Z: a test of mine wrote to the operator's real Master home.** One of the R19 tests I wrote patched `master.accessLevel` to an elevated level and back through the settings route without stubbing `master.applyMasterAccessLevel`, which applies the level to the Master's home directory; in a test process that is the operator's real `~/.tangleclaw/master`. The live `.access-level` file went from `write` to `read-only` while the real config still said `write`. Expected: a route test touches only its temporary store. Actual: it reached a function with a side effect outside the store. Root cause: I copied the shape of my own earlier tests in that block, which had only ever sent an unchanged `read-only` and so had never triggered the apply, and did not read how the neighbouring accessLevel tests isolate the route; they stub that function, and the file ends with a guard test that fingerprints the real home, which is what caught it on the first run. I stopped, inspected read-only, reported to the PM and the Architect, and did not restore the file: writing `write` into a live access control is not mine to do. The test is removed and the whole block now stubs the function, verified by the real file's size and modification time being unchanged across a run.

**Incident addendum (corrects the paragraph above, which named one file).** By the code, the unstubbed call did more than rewrite `.access-level`: `applyMasterAccessLevel` delegates to `refreshMasterIdentity`, which also rewrites the home's `CLAUDE.md`, `memory/FLEET.md`, `memory/HOWTO.md`, the guard script and `.claude/settings.json`, and in that test process it rendered them from the TEST store. So from 01:01:26 to 01:03:05 PDT (99 seconds) the live Master home MAY have held test-derived identity and fleet content, not only a wrong level. I did not read those files inside the window, so I cannot say what they held. The PM restored all six files at 01:03:05 PDT through the authoritative settings PATCH; I verified afterwards, read-only, that the level read `write`, that no test names appeared, and that the API base was the live one. The PM's audit of the window (R20): the Master pane had no turn or action between its completed 00:53 work and its 01:13 scheduled sweep, and the server log shows only empty bridge-helper outbound-claim polls, with no Master message handling, candidate release, route action or Discord publication. No Master consumption or action in the window was observed; that is the PM's bounded finding and not a claim that none was possible.

**R22: a revocation that was saved and not applied.** The Critic's verify pass on the R19 head found that my statement "write access can always be revoked" was false. Expected: with the stored engine's profile bad, a `write` to `read-only` change takes effect. Actual: the route saved it, then `applyMasterAccessLevel` resolved the Master's engine BEFORE writing the level, and that resolution lists every installed profile and throws if any one does not parse. The level file kept `write`, the guard kept allowing, and the route answered 500. Root cause: R17 to R19 fixed where the settings were VALIDATED and I wrote the docs as if saving were applying; I never followed the saved level to the function that enforces it, and my route tests stubbed that function, so nothing I ran could have shown it. The Architect ruled a narrow fix: a change that does not widen access no longer needs the engine. On a fault it writes the level and the Claude guard (inert on other engines) and throws an error that says the level is on disk, whether the guard reads back, and that the identity was not refreshed; the route turns that into a 500 that says which half holds. A grant is never applied through the fault. "Tightening" is judged against the level FILE, read as the guard reads it (missing or unknown is `read-only`). What this does not do: it does not bind a running Master on a non-Claude engine, whose only boundary is instructions it read at launch; the message says so. It also leaves alone the older path where the level landed and a later refresh step failed: there the guard write is the last step, so a tampered guard may not have been restored, and the existing message says the guard may be a step behind. The tests drive the real function against a temporary home provisioned at `write`, with the guard blanked, deleted, unhooked or its directory removed, and run the guard script itself to see it deny. The R19 route tests now set `write` first, use real profile files in the test store (missing, `null`, truncated), assert the applier was called once with `read-only`, and restore settings through the store instead of the route. The 400 for an unparseable profile no longer quotes the parser.

**R23: the same fault when the engine resolves to nothing.** The Architect's pre-review of the R22 head found that I had handled a resolution that THROWS and not one that answers null. `resolveDefaultEngine` returns null when none of the engines it lists is detected as available and either no engine is configured or the configured one is among the undetected (I first wrote "when no profile is installed" here and in the docs, which is wrong: with the default configured engine and no profiles at all, the unknown id is passed through as `claude`), and `_masterRuntime` reads any id that is not `claude` as instructional enforcement; so for a Master running Claude Code on a machine where no engine was detected, and whose guard had been deleted, a `write` to `read-only` change wrote the level, wrote no guard and returned a clean success. Expected: no engine is "could not find out". Actual: it was "not Claude". Root cause: the defect class this whole item is about, in the fix for it. I tested the fault I had been shown (a throw) and did not ask what else the resolver can answer. `applyMasterAccessLevel` now treats an engine id that is not a non-empty string as unresolved, so tightening takes the conservative path and a grant is refused. It also resolves once and hands that answer to `refreshMasterIdentity`, which used to resolve again and could reach a different one.

**R24: the same fault with an answer attached.** The Critic's pass on the R23 head found that resolution does not only throw or answer nothing: when the configured engine is in the selection list but not detected and another is, it answers the OTHER engine. `_masterRuntime` reads that as instructional, so a Master running Claude Code had its level written, its deleted guard left deleted, and the route answered 200. Expected: enforcement reflects the running Master. Actual: it reflects what a new Master would start on. Root cause: three rounds (R22, R23, R24) each closed one way the resolver can be wrong about the live Master, because I kept asking "what else can this call return" one value at a time; the question that ends it is that the change path has NO evidence of what the live Master runs, so a tightening must not depend on the answer at all. The PM ruled: every non-widening change writes and reads back the level and the Claude guard whatever was resolved, and a grant is refused when the engine is unresolved, unusable or substituted. Costs, stated in the docs: a Master that really runs another engine gains two unused files in its home on its first downgrade, and on an install whose configured engine is not detected, raising the Master's access is refused until `master.engine` names the engine in use. Four existing tests modelled "a Master on Gemini" with a resolver answering `gemini` while the config still said `claude`, which is exactly a substitution; their fixtures now set the Master's engine, with a note saying why, and their assertions are unchanged except the one whose claim R24 reverses (an instructional Master is no longer handed no guard on a DOWNGRADE; it still is on a grant). Not cured: the same reading at boot and at Master start (below, with O2).

**R24 follow-up: three sentences of mine that were not true.** (a) I wrote that resolution answers no engine when "none of the installed engines is detected". That is the R23 mistake in new words: an unknown configured id is still passed through as itself. The condition is no available engine AND no configured id that passes through. Then I wrote THAT wrongly too, as "a configured id with no profile is passed through": the resolver tests membership of the selection list it is handed, and `listWithAvailability` drops `pickerHidden` profiles before it, so a configured `openclaw` has a profile file and is still passed through. The record now states the rule relationally (an id absent from the selection list passes through; otherwise, with no listed engine available, null) and names no engine or file. (b) I told operators to set `master.engine` to "the engine in use" to clear a refused grant. In the motivating case the engine in use IS the configured one that is not detected, so that changes nothing, and the engine guide said something different. The refusal clears when the configured engine is detected again, or when `master.engine` names the resolved engine, which is right only if the running Master really uses it. (c) Three comments still said an instructional Master gets no guard. Root cause for all three: I corrected each sentence against the last review comment and not against the code path it describes. Also: when the level file and guard do not both read back after an otherwise complete change, the route now says so in its own sentence instead of "may be a step behind". My first wording of that sentence told the operator to change the access level and change it back to retry, which asks for a temporary grant; the Architect caught it. It now says to repair the home's writability and restart, and that a restart regenerates the guard only for a Master that resolves as Claude Code. **Launch-identity limits, recorded and not cured (Architect ruling, separate work):** TangleClaw keeps no record of the engine a running Master was started on, so (L1) when the configured engine is Claude Code, a Master started earlier on a substituted engine is reported as `structural` once Claude Code is detected again, though it reads no guard; no boundary is lost relative to an ordinary instructional Master. (L2) With neither `master.engine` nor `defaultEngine` set, there is no configured id to compare, and a grant is applied on whichever available engine the resolver picks; the shipped default sets `defaultEngine`.

**CI red on the published R27 head: three tests that passed here for a reason about this machine.** CI run 37755360278 failed three cases in `test/master-medusa.test.js` (one from main, two I added in R17). Each sends a command to the Master through a fake tmux and the REAL engine resolver. Expected: they test delivery. Actual: they tested whether the host has an engine CLI; this machine has four, the CI runner has none, resolution answered no engine, and the R17 refusal fired as ruled. Root cause: when R17 made "no engine resolved" a refusal, I reversed the one test that named the engine fault and did not ask which other tests in the block reached the resolver unpinned; and every local run since has been on a machine where the answer is always an engine. The three success calls now pin the resolver; the refusal half of the parser-fault test stays on the real one. Check that would have caught it, now part of how I verify: run the changed test files with an engine-less PATH (`env PATH=/usr/bin:/bin node --test <file>`). The product fact CI demonstrated is a cost and is stated in the PR body: on a host where no engine CLI resolves, every command into a running Master's pane, switchboard nudges included, is refused until resolution answers an engine.

**Limits this branch does not cure, ruled out of scope by the Architect and given to the PM for tracking.** (O1) With the engine unresolved, a request that reads as a grant against the level FILE is refused and writes nothing, including when the stored setting was higher (setting `write`, file missing or `read-only`, request `suggest`). If the guard had been deleted or unhooked it stays that way; only a change to `read-only` restores it. Refusing is correct; repairing the guard on a refused request is separate hardening. (O2) `refreshMasterIdentity` at boot and `ensureMasterSession` still resolve the engine before writing the level. If the stored setting says `read-only` while the level file says `write` and a profile cannot be parsed, sending `read-only` again is not a change (200, applier not called) and boot and ensure throw before the level write. The way out is to change the level and change it back, or repair the profiles. The same two callers also read "no engine" and a substituted engine as instructional, so a boot or a Master start in that state writes the level and restores no guard, with nothing thrown. (O3) When the level lands and a later refresh step fails, the guard write is the last step, so a tampered guard may not have been restored; the message says the guard may be a step behind. All three predate this branch.

**What a "0 failed" total can hide.** While writing the R16 tests, two new describe blocks threw during setup (a hook that was not imported). Node's summary for that run said `# fail 0` with the suites marked `not ok`: a suite that fails outside any test is not counted as a failed test. That is a mechanism by which a run can exit non-zero with zero failures recorded, and a plausible account of the recorder's two unexplained exit-1 runs (a suite-level or hook failure under load), though I have not shown that is what happened there. The gate reads node's exit code and any `not ok` line at any depth, not the failure count alone.

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
