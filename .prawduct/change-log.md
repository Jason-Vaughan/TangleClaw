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

## 2026-09-25 — A wrap never commits a SQLite database, and it recommends safe answers (#1858)

<!-- prawduct: type=bugfix | scope=wrap-file-safety-1858 -->
Chunks 01–03 of `.tangleclaw/plans/1858-wrap-file-safety.md`. The new `_file-safety.js` gives each file one of four classes: protected, local, durable or ambiguous. `classify` withholds protected files (SQLite by header, extension or sidecar) from every bucket, so neither `session-files` nor `commit` will stage one, whatever Include arrives. Ignored Includes are recorded. Other files carry an advisory recommendation, and no answer is preset. Both steps emit a manifest by path, and `session-files` emits exact ignore lines. `changelog-coverage` no longer counts a withheld database as work. The drawer shows each recommendation, a projected manifest before a new Apply-recommendations-and-retry button, the withheld databases with no choice, and the manifest on settled rows. It also prunes remembered answers for withheld databases. The Architect ruled on A1–A8 on 2026-09-25 (A8, a handback refusal, was rejected and is not built).
## 2026-09-25 — `launch-rule-drift` tests import `node:assert/strict` (Pilot 4)

<!-- prawduct: type=chore | scope=strict-assert-launch-rule-drift -->
`test/launch-rule-drift.test.js` switched from `node:assert` to `node:assert/strict`, as the testing-conventions norm requires. Every assertion already called a strict method, so no test's accepted behaviour changes. Substituted for TST-5N8W, whose conversion shipped in #1378. Three suites still import non-strict `node:assert` (remote-output, wrap-consecutive-step-delivery, wrap-delivery-receipt) — tracked against #1377.

## 2026-09-24 — `/clear` and compaction no longer drop a session's rules and launch context (#1761)

<!-- prawduct: type=bugfix | scope=reentry-1761 -->

Dual-Builder Pilot 3 (TangleClaw-Pilot-B2). Architect rulings A1–A5 are in `.tangleclaw/plans/1761-clear-drops-context.md`, and ADR 0017 § 7 records them.

**The change.** Chunk 01 adds `tc start review` (`GET /api/tc/start/review`, `lib/launch-sequence.js#review`). It re-reads any page of an attested launch's frozen snapshot, read-only, under a banner saying this is not a new launch. It refuses `NOT_READY` before READY and keeps `next`'s binding refusals. Every engine's generated config carries a "Lost your launch context?" pointer to it (`lib/ecosystem-primer.js#contextReentryLine`). Chunk 02 registers the prime and rules hooks on `startup|clear|compact`. On a re-fire, the prime hook puts `.tangleclaw/session-reentry.md` (`lib/session-reentry.js`, written and removed with the prime) ahead of the prime. The rules hook posts its delivery receipt on `startup` only. Both hooks read `source` from stdin with a 1-second bounded read, fall back to startup, and say so on stderr when a stdin they were sent cannot be read. The page budget now covers the review decoration by construction; its value is unchanged. The ADR amendment is § 7, plus a READY bullet, a Consequences paragraph and a shipped/desired row.

**Tests.** New: `test/launch-review.test.js` (a full walk returns exactly the digested bytes and leaves pages served, cursor, revision and READY byte-identical; a rule added after READY does not reach the re-read; binding parity), `test/session-reentry.test.js` (the preamble stands on its own), and additions to the `tc start` CLI, prime-hook, receipt, merge, shell-safety, sessions and engines suites. Four assertions pinned the `startup` matcher. They now pin the widened one at the same strictness, because the requirement changed (A3); this is not a weakening. Mutation checks: removing the receipt's source guard fails both re-fire tests, and removing the rules hook's stderr line fails its test. Checked by hand in a throwaway Claude Code 2.1.282 pane: `source` arrives as startup, clear, compact and resume. The preamble and the rule marker came back after `/clear` and `/compact`, and the widened matcher did not fire on `resume`. A TangleClaw-launched pane calling `tc start review` against a live server was not run; spawned-`tc` tests against an in-process server cover that path.

**Critic.** The cumulative review found 0 blocking, 0 warnings and 7 notes. Two were fixed: the misplaced JSDoc paragraph, and the silent startup fallback on an unreadable source. Five were accepted: 0-based `--page`, which matches `next`; the duplicated stdin block, since each hook must stay self-contained; and three informational notes. The first `verify-resolutions` found one blocking issue: the rules hook's stderr line was untested. It was fixed, and the second round found none. Flagged, not fixed here, as in Pilot 2: the `risk_surfaces:` flow list in `.prawduct/project-state.yaml` that `classify-diff-risk` cannot parse.

## 2026-09-24 — `GET /api/ports` lists the root-owned listeners the lease guard already refuses (#1771)

<!-- prawduct: type=bugfix | scope=ports-1771 -->

Dual-Builder Pilot 2, Lane 1 (TangleClaw-Pilot-B1, Control lane). Architect rulings A1–A4 are in `.tangleclaw/plans/1771-root-listeners.md`.

**The change.** `port-scanner.scan()`, which feeds the `systemPorts` list, used to read only lsof. As a normal user, lsof misses listeners owned by root and other users, which the lease probe already caught through the kernel socket table (#814). Now one reader, `_readSocketTable()` (`netstat -anv -p tcp` on darwin, `ss -Hltn` on linux), feeds both the scan and the probe. The scan names every pid with one batched `ps` (`_commandsOf`). The probe still names only the pid it found. On a port both sources see, lsof's entry wins. A listener only the socket table sees is listed with `command: null` when it cannot be named, and `pid: null` when unknown (always, on linux). `scan()` now goes through the `_exec` seam, and it reads lsof's silent exit 1 as "none of this user's" rather than warning on every scan.

**Tests.** The single-port parsers `_parseNetstatListener`/`_parseSsListener` are removed, because the shared reader made them production-dead. Their tests are consolidated onto the whole-table parsers with the same inputs and the same invariants (address shapes, suffix-only ports, non-LISTEN rows, a `-` pid), plus a scoped IPv6 address. New tests cover the merge, lsof precedence, Linux null identity, one batched `ps`, `ps` failing outright, the source-failure matrix, and scan/probe parity on darwin and linux fixtures. The engines test that picked a real-host scan entry is now fixture-driven (A4). It asserts that a named and an unnamed listener are both unavailable, and checks the process only for the named one. A mutation check (merge disabled) fails four scan tests.

**Critic.** The first review found 0 findings and 11 observations. Acted on: the scan and the probe now share one socket-table reader (the plan had said so and the code had not), the missing `ps`-failure and scoped-IPv6 tests are added, and the route comment no longer claims more than a cached scan can deliver. Accepted: the CHANGELOG's ruling citation, which matches how other entries cite their rulings. The second review (0 blocking, 0 warnings) found two things to fix: `scan()` warned on lsof's silent exit 1, and the docs said `pid` is always null alongside `command`. Both are fixed. Accepted: the `_commandOf`/`_commandsOf` pair (folding them together would mean rewriting the probe test's `ps` output for no change in behavior), the overlapping parser test blocks, and debug-level socket-table failures (a deliberate plan choice). Flagged, not fixed here (the PM scoped this PR strictly to #1771): the `risk_surfaces:` line in `.prawduct/project-state.yaml` uses an inline-list form that `classify-diff-risk` cannot parse.

## 2026-09-24 — version-bump no longer writes inside `.prawduct/` (#1766)

<!-- prawduct: type=chore | scope=vb-flip-1766 -->

Dual-Builder Pilot 2, Lane 2 (TangleClaw-Pilot-B2, the Continuity Test subject). Architect rulings A1–A3 are in `.tangleclaw/plans/1766-version-bump-flip.md`, and ADR 0011 is the controlling rationale.

**The change.** On a release promote, the `version-bump` wrap step rewrote `status=merged` tag lines in the project's `.prawduct/change-log.md` to `status=shipped`, and counted statusless tag lines. ADR 0011 says no TangleClaw code writes inside `.prawduct/`, so the flip was a boundary violation. It was also dead: prawduct stopped writing `status=merged` in v2.3.2 and retired its only reader in v3.3.0. The flip helpers, the `version-bump:prawduct-change-log` staging key, the step's `changeLog` / `changeLogWarning` output and the commit body's "Stamped N" line are removed. No fallback is kept for older prawduct (A1). The shipped #1311 and #1059 plans move to `.tangleclaw/plans/archive/`.

**Tests.** The WRP-9F2K block pinned the removed behaviour and is deleted. That does not weaken a contract, because the behaviour was removed on purpose. It is replaced by one regression test pinning ADR 0011: a promote over a ledger that still has `status=merged` lines stages and flushes only version + CHANGELOG, and the ledger stays byte-identical. The test fails against the pre-change code. Two release-gate tests keep their `status=merged` seeds, with a comment saying the version and CHANGELOG assertions carry the proof.

**Critic.** The cumulative review found 0 blocking and 0 warnings. Its three code notes (a test title, a comment reflow, a history-narrating comment) were fixed and confirmed by `verify-resolutions`. Two environmental notes and one observation were accepted.

## 2026-09-24 — A failed origin lookup backs off instead of re-spawning on every check (#1059)

<!-- prawduct: type=bugfix | scope=upd-1059 -->

Dual-Builder Pilot, Lane 1 (TangleClaw-Pilot-B1). It ships backlog item UPD-3F7Q. Architect rulings A1–A3 are in `.tangleclaw/plans/1059-origin-lookup-backoff.md`.

**The change.** `_getReleasesUrlBase` still memoizes a real answer (a URL base, or `null` for "not a GitHub remote") for the life of the process. A thrown `git remote get-url origin` used to be retried on every check that found a release. That retry is a synchronous spawn of up to 2s, and at the 10s manual refresh floor it could stall a degraded install over and over. A failure now starts a fixed 5-minute window (`ORIGIN_LOOKUP_BACKOFF_MS`, its own constant per A1) during which the lookup returns `null` without spawning. The first call after the window retries. The window is read from a new monotonic `_internal.now` seam (`performance.now()`), so stepping the wall clock backwards cannot stretch it. The sync pre-flight and the async completion path share one window (A2).

**Tests.** The old "does NOT memoize a failure" test asserted two spawns back to back, which is the behavior this change removes. It now keeps its contract (a failure is not cached forever, and the link recovers) across the window. New tests cover: no spawn inside the window, a retry at the edge, re-arming after a second failure, `_reset` clearing the back-off, and one spawn across two `checkForUpdateAsync` measurements.

**Critic.** The cumulative review found 0 blocking and 0 warnings. It left two notes on the plan's Status boxes and pilot-envelope wording, and both were fixed. After rebasing onto #1842 (#1311), the full suite was green on the combined target and a fresh cumulative review again found 0 blocking and 0 warnings. Its notes were the plan's clock wording (fixed) and the frozen markdown backlog entry for UPD-3F7Q (accepted: the live item is #1059, which closes at merge).

## 2026-09-24 — The Kill modal names the right mechanism for a webui session (#1311)

<!-- prawduct: type=bugfix | scope=kill-modal-1311 -->

Dual-Builder Pilot, lane 2 (Builder B2). The Architect's rulings A1 and A2 are recorded in `.tangleclaw/plans/1311-kill-modal-sessionmode.md`.

**The fix.** `public/ui.js#openKill` picks between "tears down the SSH tunnel" and "terminates the tmux session" by reading `proj.session.sessionMode`. Neither card projection emitted that field. `lib/projects.js#_liveSession` and `#_unknownSession` now pass `row.sessionMode` through. `_rowToSession` in the store stays the only owner of the `'tmux'` default. `lib/project-view.js#publicProjection` is deliberately unchanged: the dashboard always resolves as the operator and receives whole rows.

**The test.** `test/card-session-contract.test.js` runs the real `openKill` against output from the real store and projection, for both a webui card and a tmux card. It also guards the defect class: every `session.<field>` read in `public/ui.js`, `public/api-helper.js` and `public/landing.js` must be a key that `_liveSession` emits. A self-check fails the guard if its scan finds nothing, so it cannot pass vacuously. The tests were red before the fix and are green after.

**Critic.** The cumulative review found nothing blocking. One note was accepted: the guard matches any identifier named `session`, which is the known limit of A2.

## 2026-09-24 — A Codex session's wake is judged by its app-server, not its status row (#1628)

<!-- prawduct: type=bugfix | scope=wake-1628 -->

This is Builder2's #1628 recovery, rebuilt from main on the #1825 app-server channel. It replaces the held status-row parser, which the Architect rejected on 2026-09-19 and which stays untouched on `fix/1628-status-row-provenance` as evidence. Architect rulings D1–D10 are in `.tangleclaw/plans/issue-1628-recovery-plan.md`.

**The observation.** Adapters gain an optional `observeActivity(channel, project)`. Callers reach it only through `startupControl.observeActivity({session, project, channel, sequence})`, which answers `channel: absent|present`. Before any adapter is asked, it validates that the channel belongs to this active session and to its launch, engine and project. `declaresObserver` says which engines are meant to be judged this way: the adapter must resolve through the registry and implement the method. The Codex adapter reads it read-only. It checks the process identity and the version, and requires exactly one loaded project thread, the recorded one. An unrecorded thread is bound compare-and-set through a new `store.startupControlChannels.updateAdapterStateIf`, so a recorded thread is never replaced. The row is re-read before an `idle` answer is returned.

**The wake gate.** Only for observed engines: a fresh `idle` for the current session, channel and launch reaches the pane gate, where it excuses the at-rest marker alone. `busy` holds as `engine-thread-busy`, anything unproven as `engine-thread-unknown`, no channel as `engine-channel-absent`, and a Codex Project Master as `master-engine-unobserved`. The pane's whole-tail marker match false-idled on quoted prose (ledger 5030). The read is asynchronous behind a synchronous tick: one read in flight per session, channel and launch; late results are discarded; nothing is injected from the callback. Other engines are untouched and never have a channel looked up.

**Critic.** The cumulative review found one blocking issue: a Codex Master would have held forever under a code that advised a relaunch. It was fixed, and verify-resolutions came back clean. One observation was accepted: the reason-change log line has no test, and it only writes diagnostics.

## 2026-09-23 — A native launch is bootstrapped through its startupControl channel, and the launch panel shows every startup fire (#1825)

<!-- prawduct: type=feature | scope=startupcontrol-1825 -->

#1825 Chunk B3, the automatic bootstrap and the launch panel (`lib/launch-bootstrap.js`; Architect rulings F1–F6, F1 corrected once).

**The selection is durable.** A launch decides its startup path when the channel starts — `native` when the channel opened AND there is a sequence to read through it, else `legacy` — and freezes it on `launch_sequences.startup_delivery` (schema v47) in the transaction that binds the sequence. Every later reader (the deferred init, the unready monitor, the panel, a restart) reads one answer.

**The native path types nothing.** `_deferEngineInit` withholds the engine's preKeys, the prime paste and the kickoff; `launch-unready` stamps the window and answers `native-startup` instead of nudging; the inline-rules ledger row reads `skipped` with the served-by-sequence reason. After `_awaitPaneReady`, the bootstrap fires the startup prompt once through `startupPrompt.fire` — the one service path — as the internal `launch` caller (`launchCaller`, clearance `launch-automatic`, attributed to the launch's own project, proven inside the fire transaction against the exact session, project and current sequence) under `launch-<sequence>-r<revision>`. A gate that never passes still produces the audited intent row and is settled `blocked (pane_not_ready)` by the service without reaching `adapter.fire`. No paste fallback, no retry. Legacy launches keep their path and are recorded through the same service (`unsupported`, including `engine_declares_none`; or `blocked (channel_unavailable)`).

**The app-server inherits the pane's environment** (`_paneEnvironment`: PATH floor, `TANGLECLAW_PROJECT_ID`, `TANGLECLAW_API`, `TANGLECLAW_WORKSPACE_ID`, `TANGLECLAW_LAUNCH_ID`). On the understanding that with `--remote` the agent loop runs in the server, a `tc start next` the fired prompt asks for is expected to resolve to the launch, where before it had no identity. An assumption until the post-merge live check confirms it (`VRF-1825-b3-native-bootstrap`).

**The panel.** `GET /api/launch-sequences` carries `startupDelivery` for every caller and, for the operator and Master only, `startupControl: {channel header, fires incl. denied, fireable}` — never `adapterState`; bound callers get no block (D4). The Launch readiness panel renders it and wires a Fire button on active open-channel rows that reads the current revision at click time. Retention (F6): newest 200 fire rows and 100 closed channel rows per target project among ended sessions, active-session rows exempt, trimmed inside the writing transaction. Adapters stop at shutdown; the keep-running wrap and the boot re-sync channel release are pinned by tests.

## 2026-09-24 — The startup prompt fires at Codex through its app-server, with an engine-signed receipt (#1825)

<!-- prawduct: type=feature | scope=startupcontrol-1825 -->

#1825 Chunk B2, the Codex adapter (`lib/startup-control-codex.js`, over a hand-written RFC 6455 client on a unix socket, `lib/ws-unix-client.js`). Verified against codex-cli 0.156.1 with six spend-free probes and one operator-authorized live turn that went `dispatching → accepted → applied`.

**The channel.** A Codex launch starts one `codex app-server` per launch, detached in its own process group, and attaches the pane's TUI with `--remote` ahead of the validated launch-mode arguments. `startup_control_channels` (schema v46) records it as a generic header plus adapter-owned state; the channel ends with the session (kill, a wrap that ends it, a detected crash, a relaunch), is revalidated and recovered at boot, and is reaped when its session has ended. A process is signalled only when its command line, socket and birth time match the record. A launch that cannot start its channel launches as before and records why as a closed row; a later fire cites it (`channel_unavailable`).

**Readiness and blockers.** Read from the protocol only: server version against the installed and recorded one, trust from `config/read`, the account, an explicit usage allowance or usable credits, exactly one idle thread for the project directory. Unknown fails closed (`readiness_unknown`); a pre-send blocker answers `409 STARTUP_FIRE_BLOCKED`, sends nothing and releases the launch's slot.

**The receipt.** `turn/start` carries a digest of the launch-start payload: session, launch and its revision, the priming pact (a versioned canonical object over the four frozen launch-step digests), a role-and-assignment revision derived only from the frozen snapshot (project binding, rule fingerprints, consumed handoff), and the prompt's revision and digests; the launch bearer is hashed in and never stored. Accepted needs the engine's echo of that digest WITH the prompt's exact bytes; applied needs that turn to complete after accepted evidence; approvals and questions keep it accepted under `approval_pending` / `user_input_pending` and are never answered by TangleClaw. A lost answer is `indeterminate` and never resent; it settles only from an exhaustive, paginated read of a stably idle thread. `thread/resume` was refused after the send on this version, so the watcher also re-reads the engine's record on an interval. A restart recovers every in-flight fire without resending, through the service's one transition writer. The fire route now waits up to ten seconds for acceptance and answers with the record as it stands; the watch continues.

**Schema v46** rebuilds `startup_prompt_fires` in one transaction (every row copied by name, the `reason_code` CHECK widened to the adapter's codes, and `payload`, `payload_digest`, `engine_thread_id`, `engine_turn_id`, `dispatched_at`, `accepted_at`, `settled_at` added); `startupPrompts.updateFire` enforces forward-only transitions from `STARTUP_FIRE_TRANSITIONS`, and terminal outcomes are final.

Architect rulings E1–E9 (message 2ad0567c). Critic: cumulative (2 blocking, 9 warning, 12 note) resolved across two verify rounds to 0 findings.

## 2026-09-23 — A revisioned, operator-owned startup prompt, and the startupControl capability it will fire through (#1825)

<!-- prawduct: type=feature | scope=startupcontrol-1825 -->

#1825 Chunk B1, the engine-neutral foundation. No engine can receive it natively yet: the adapter registry ships empty, so every fire is a typed, recorded `STARTUP_CONTROL_UNSUPPORTED`, with no keystroke fallback.

**The prompt.** `startup_prompt_revisions` (schema v45) is append-only and written by compare-and-set. Each revision stores the exact text and its digest, the firer project ids (sorted, unique, with a canonical policy digest) and honest provenance (`operator-verified` with a username, or `open-install-unverified`). The firer list lives with the prompt, not in `config.json`, because `PATCH /api/config` is reachable by agent sessions (the D4 correction). The dashboard editor keeps the operator's edits on a refusal and shows the server's reason.

**Firing.** `POST /api/sessions/:project/startup-prompt/fire` accepts the operator (through the strict operator proof, now shared with the recovery clear as `_requireOperatorWrite`) or a listed project sharing a group with the target. Out of scope answers the same 404 as missing, and the denial is recorded. A fire's checks and its intent row are one transaction. It is idempotent by caller key, holds one active fire per launch, never re-applies an applied revision, and never carries the launch id.

**Capability.** `lib/startup-control.js` validates a profile's `startupControl` block like `wake`, and resolves it against a code-only adapter registry and an exact verified version. `tc capabilities` reports `startup-control`. Architect rulings D1–D8, message 29790e23. Critic: three rounds, clean.

## 2026-09-23 — A release publishes only the exact commit it tested, under a tag that dereferences to it (#1551)

<!-- prawduct: type=feature | scope=train-a-car-a4 -->

Train A Car A4 Chunk 02, the car's last. `release.yml` checked only that tag `vX.Y.Z` existed. It never checked which commit the tag named, and it published without any test result for the commit it released.

**Tested in the same run.** `test.yml` gains `workflow_call`. The release workflow's `test` job runs it on `GITHUB_SHA`, and the publishing job `needs:` it with no status override. Tested and released are one commit by construction (Architect B1).

**The tag must name that commit.** `scripts/release-tag-gate.js` resolves the tag through its peeled `^{}` line and fails closed on output it cannot parse or an absent tag. Any existing tag that names another commit refuses red, even when its Release exists (B2 MODIFY). The tag is checked again on origin after a push, and the checkout is confirmed as `GITHUB_SHA` before tagging. A live probe found that `ls-remote` with one pattern drops the peeled line, so both patterns are requested. Otherwise every annotated release would have refused.

**Token scope and recovery.** The top-level token is `contents: read`, and only the publishing job holds write (B3). `docs/release-process.md` splits recovery by whether the tag reached origin (B4, refined after Critic R-3 blocking). ADR 0014's honest-limit status is updated (addendum). Tests: `test/release-tag-gate.test.js` and `test/release-workflow.test.js`, with 14 mutations watched red, and actionlint is clean. The plan, with the rulings, is archived at `.tangleclaw/plans/archive/train-a-car-a4-build-plan.md`. The merge waits on the Operator's direct CI go.

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
