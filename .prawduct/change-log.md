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

## 2026-10-27 — v5.42.0 W1-A: extract shared pane-writer behind launch-unready and launch-kickoff (#1669)

<!-- prawduct: type=internal | scope=w1a-1669 -->

- **#1669:** Extracted the pane-capture, idle-assessment (with its best-effort cursor fallback),
  injection-result classification, and swallow-and-warn activity-logging mechanics shared by
  `launch-unready.js` and `launch-kickoff.js` into a new `lib/launch-pane-writer.js`, per Architect
  Pre-Flight Ruling A477-COSIGN-20261027T2307Z. Each caller's own one-shot state machine is
  untouched: `launch-unready` still counts a nudge only after a successful send, and
  `launch-kickoff` still claims its fire-once slot before sending and releases it only on a
  pre-send bailout. Both existing test suites (`test/launch-unready.test.js`,
  `test/launch-kickoff.test.js`) pass unchanged against the extracted module; added
  `test/launch-pane-writer.test.js` to cover it directly.
- Noted for the record rather than changed (outside this car's authorized file scope): the
  independent PR reviewer observed that `assessIdle` now runs inside the same try/catch as
  `capturePane` in both callers, where it previously ran unguarded. For `launch-kickoff` this
  closes a latent gap against the module's own "never rejects" invariant; for `launch-unready` it
  changes only the log message and an `idleTicks` reset on an `assessIdle` throw, not the verdict
  code returned. The cumulative Critic review of this exact diff passed with 0 blocking.
- Also noted: one pre-existing, unrelated full-suite failure
  (`record-test-run.test.js`'s "declares the suite-evidence wrapper" check) reproduces identically
  against `origin/main` with no local change to the files it reads (`.prawduct/project-state.yaml`,
  untouched by this branch). It tracks the open, Operator-held #2371 cutover — `scripts/suite-evidence.js`
  is built but not yet declared as `test_command` — which is outside this car's authorized scope to
  fix.

## 2026-10-27 — v5.41.0 W4-REL: prepare the release candidate

<!-- prawduct: type=internal | scope=v541-w4-rel -->

- Promoted the 13 accepted wrap-resilience, plan-resolution, handoff, Medusa and session-range fragments into `CHANGELOG.md`'s 5.41.0 section and removed their consumed files. Set `version.json` to 5.41.0, updated both README clone pins, extended the released-section hash lock through `scripts/release-prepare.js`, and recorded the candidate's pending release, production and activation finish lines in `docs/releases/v5.41-status.md`. Publication remains subject to the Operator's exact-target release approval.

## 2026-10-27 — v5.41.0 W3-REC: reconcile the shipped wrap record

<!-- prawduct: type=internal | scope=v541-w3-rec -->

- Reconciled all 13 v5.41.0 issues in `FEATURES.md` with real test citations, filled the W1-B, W1-D and W2-A change-log gaps below, and updated the operator's wrap guidance in `docs/user-guide.md`. This records the already-merged code; it changes no runtime behavior.

## 2026-10-27 — v5.41.0 W1-D: process groups and handoff continuity (#1503, #1651, #1733)

<!-- prawduct: type=fix | scope=w1d-1503-1651-1733 -->

- **#1503:** Timed-out and over-buffer wrap-step commands now stop their whole process group, confirm it is gone before resolving, and report uncertainty if confirmation cannot be established. A command that catches `SIGTERM` and exits still reports the timeout that occurred.
- **#1651:** `publishHandoff` rechecks the staged file digest inside its `BEGIN IMMEDIATE` transaction before publication.
- **#1733:** A wrap mirrors live `.prawduct/.handoff-notes.md` for the next Claude SessionStart hook. Successful reading consumes the mirror; a failed read preserves it, and a later wrap with no notes clears an obsolete mirror.

## 2026-10-27 — v5.41.0 W1-B: plan resolution and legacy-plan retirement (#1050, #1522, #1757)

<!-- prawduct: type=fix | scope=w1b-1050-1522-1757 -->

- **#1050:** Migrated the 12 authorized local projects from `.claude/plans` to `.tangleclaw/plans` and retired the legacy directory as a fallback for TangleClaw's own wrap plan resolution. The plan-docs service still reads legacy locations for managed projects it serves.
- **#1522:** The shipped-issue filter now runs when a plans directory contains exactly one Markdown plan, as it already did for multiple plans.
- **#1757:** A missing, archived or completed `activePlan` pin no longer blocks selection. Its removal is staged with the wrap transaction; a genuine choice among multiple live plans still asks the operator.

## 2026-10-27 — v5.41.0 W2-A: session-range evidence and heavy-repo wait budget (#670, #1782)

<!-- prawduct: type=internal | scope=w2a-670-1782 -->

- **#670:** Session-range resolution now warns when a recorded `lastWrapSha` or `launchSha` cannot be used and the range falls back to trunk, naming the stale or orphaned boundary. A genuine first wrap emits no downgrade warning.
- **#1782:** The `ai-content` wait budget scales with the project's plan-file count, up to 20 minutes. A step completing after 80% of its budget logs and surfaces a warning in the wrap result.

## 2026-10-27 — W1-A: wrap-run resilience (#1321, #1805, #1816)

<!-- prawduct: type=fix | scope=w1a-1321-1805-1816 -->

- **#1321:** `anyRunning` (the restart gate) and the wake monitor's `wrapRunning` check both silently changed their verdict once a wrap run went stale, with no record of either transition. `wrapRunRegistry.warnStale(projectName, site)` now logs once per run per call site the moment either one permits something a live run would have refused.
- **#1805:** a stale takeover used to replace a project's run unconditionally even though the pipeline behind it might still be executing, letting two pipelines run for one project. `begin()` now splits on whether the stale run had reached its own cancel boundary (`cancellable`): short of it, the takeover proceeds automatically and the displaced pipeline is told to stop (`_displacedCancelled`, consulted by `admitStep`/`isCancelRequested` before the usual project-keyed lookup, since the takeover already replaced the entry those calls would otherwise be checked against); past it — it may already be committing, branching or pushing — the takeover refuses instead, with no override, because no request can make two concurrent git mutations safe. Found during review that an earlier `options.confirmStaleTakeover` design left a cross-component dead end (no UI caller) — redesigned around the existing `cancellable` boundary instead, closing it with zero cross-component dependency.
- **#1816:** a server restart lost the in-memory wrap run with no durable trace, leaving the session reaped as crashed with no handoff. `begin`/`emit`/`admitStep`/`finish` now write a checkpoint trail via the activity log (`wrap.run_checkpoint` / `wrap.run_settled`); `get()` recovers it once this process holds no run for a project, reporting `interrupted: true` with the last step reached and whether commit had started. Surfaced via `GET /wrap/status`'s new `interrupted`/`interruptedStepId`/`interruptedCommitStarted`/`interruptedAt` fields, and `public/wrap-run-controller.js` gained the pure reducer support (`interrupted` phase/signal) for it.
- Known gap, escalated to three filed follow-ups (outside this car's authorized 11-file scope under Charter A476): `public/session.js` needs to dispatch the new `interrupted` signal at page load (#2642); `lib/launch-recovery-held.js#_uncertainWork` needs a part for an interrupted wrap run alongside its existing `strandedWraps`/`stagedHandoff` parts (#2643); `docs/configuration-reference.md` needs the new `/wrap/status` and `/wrap` 409 fields documented (#2645, dropped from this PR's diff per PM pre-PR scope guard).

## 2026-10-27 — v5.41.0 W1-C PR #2640: Medusa mail carried forward across a wrap-ended session; injectCommand refuses mid-wrap

<!-- prawduct: type=fixed | scope=w1c-1806-2269 -->

- **#1806:** A wrap that ends the session was losing Medusa messages still unhandled in the listener's in-memory inbox: `medusa.forgetSession` now captures them before the workspace id is retired (`_captureCarriedMail`), and `medusa.startSession` seeds the project's next listener with them, oldest first (`MedusaListener#seedCarriedMail`), before opening its socket. Carried entries have no envelope id, so `markHandled` clears them locally without acking a connection that never held them; a consumer still matches them by the message body's own `id`.
- **#2269:** `injectCommand` (`lib/sessions.js`) now refuses to type into a pane whose project has a wrap running in `wrap-run-registry` (`_refuseAtRunningWrap`), the same shape as its existing startup-dialog refusal; an unreadable registry withholds the send, same as `medusa-wake`'s own fail-closed check. `lib/routes/sessions.js` maps the new refusal to HTTP 409 `WRAP_RUNNING`, added to this car's scope under a Round 2 Charter A476 addendum (confirmed 100% disjoint from every other active car) after TC-Lane-PRR-B flagged the gap in PR #2640 Round 1.
- Round 2 also corrected the branch's own changelog fragment: the original `changelog.d/1806-2269-sessions-wrap-medusa-guard.md` never matched `lib/changelog-fragments.js`'s one-issue-per-file name grammar, and its `### Fixed` heading violated the fragment body's no-heading rule. Replaced with `changelog.d/1806.wrap-medusa-mail.fixed.md` and `changelog.d/2269.inject-command-wrap-guard.fixed.md`, each a single bullet. Caught by TC-Lane-PRR-B as BLOCKING (CI run 40569582765 failed the fragment-name gate).

## 2026-10-27 — v5.40.0 W4-REL: prepare the release candidate

- Compiled 15 accepted changelog fragments into the dated `[5.40.0]` section, removed those consumed files, changed `version.json` to 5.40.0, and ran `scripts/release-prepare.js` to update README pins and extend the released-section lock. The merge that changes `version.json` will trigger the release workflow; this preparation does not tag or publish.
- Rehearsed the merged store's actual schema 68→70 upgrade on a disposable SQLite backup of the live database, leaving the live database untouched. `quick_check` remained `ok`, bridge route/outbound row counts were preserved, both `surface_kind` columns appeared, and a second open was idempotent. Three `activity_log` foreign-key violations already existed before the rehearsal and remained unchanged. `docs/releases/v5.40-status.md` records the three separate finish lines and owed post-deploy browser check.
- The release PR's merge remains held for the Operator's explicit exact-target release approval under Rule #282; preparation and review do not grant that final authorization.

## 2026-10-27 — v5.40.0 W3-REC: consolidate the Wave 1–2 feature record and operator guide

- Consolidated the v5.40.0 feature inventory in `FEATURES.md`, with real `Tests:` citations for the four merged Wave 1 cars and four merged Wave 2 cars. The record includes the already-shipped candidate wake behavior (#2133, duplicate of #2547), the records-only citation gate (#2632), and the production launch wiring follow-up (#2636) without claiming those are separate user-facing controls.
- Updated `docs/user-guide.md` for the new bridge DM surface, scoped permission decisions, TCC-aware session launch, candidate-status read, operator-needed alerts, Gateway resume, and the eligible-local-commit updater path. The bridge DM surface remains off until the operator explicitly configures and enables both sides; the live rendered-browser verification deferred for its operator panel is still owed at W4-REL under Architect A475-W2A-R6.
- Removed 184 old lines that were duplicated verbatim in `.prawduct/change-log-archive/2026-10.md` after the W2-B rebase. The archive and the following #990 entry remain intact. This is a records and guide change only; no runtime code, tests or operator-verification ledger was changed.

## 2026-10-27 — v5.40.0 W2-C PR #2637 Round 8 (test-only): the production-socket isolation test itself still touched the production socket

<!-- prawduct: type=internal | scope=w2c-2352-2625 -->

- **#2625:** The Round 7 test verifying `test/tmux-tcc.test.js` never touches the real `TCC_SOCKET` ironically touched it directly — it simulated "a pre-existing production session" by creating and killing a real session ON the literal `'tangleclaw-tcc-authorized'` socket, the exact thing the whole fix exists to prevent. Fixed by simulating the pre-existing session on a SECOND isolated/fake socket name instead, so the test suite never invokes `tmux -L` against the real production name at all, anywhere. Caught by Architect Ruling A475-W2C-R7, upholding PRR-B Round 7.

## 2026-10-27 — v5.40.0 W2-C PR #2637 Round 7 (test-only): never let the TCC-authorized test suite kill a real production server

<!-- prawduct: type=internal | scope=w2c-2352-2625 -->

- **#2625:** `lib/tmux.js` bound `TCC_SOCKET` as a fixed closure-local constant throughout — `test/tmux-tcc.test.js`'s `afterEach` runs `tmux -L <socket> kill-server` unconditionally every test, so once #2625 is live on a host with a real TCC-authorized server already running real sessions, running this suite there would destroy them. Every function that creates or checks the TCC-authorized server now reads `module.exports.TCC_SOCKET` instead (same pattern as `module.exports.createSession`), so a test can retarget the whole bootstrap path by reassigning one property. `test/tmux-tcc.test.js` now overrides `tmux.TCC_SOCKET` to a fresh, unique socket name per test (`beforeEach`) and restores it after each test's own cleanup (`afterEach`, which now only ever kills that test's isolated socket). New test asserts the default production name (`tangleclaw-tcc-authorized`) without ever invoking `tmux` against it, and proves a simulated pre-existing session on a SEPARATE isolated socket is untouched while the test runs against its own per-test overridden `tmux.TCC_SOCKET` (the entry below corrects this test's own first draft, which had briefly done the opposite of what it set out to prove). Caught by TC-Lane-PRR-B's Round 7 review.

<!-- prawduct: type=fixed | scope=w2c-2352-2625 -->

- **#2352:** `decidePermissionRequestFromUi` (`public/session.js`) called the shared `apiMutate()`, which never attaches `X-TC-Open-Token` — only `public/landing.js`/`public/ui.js` do that manually, at their own `_requireOperatorWrite`-gated call sites. The `/decide` route is the first write `session.js` has ever made to that gate, so on an OPEN (no-login) install, clicking Grant or Refuse on the session page's permission panel always failed with `403 OPEN_INSTALL_TOKEN_INVALID` — the Operator could not actually decide a permission request from the dashboard at all. Caught by Rule #275.3's live browser verification (real headless Chrome via CDP, driven from the shell to share its loopback namespace with a scratch server, after `claude-in-chrome`'s own Chrome instance proved unreachable from this sandbox) — not visible to any code-reading review, since every prior test manually constructed the header via test-harness code rather than going through the real page JS. Fixed by fetching `/api/auth/me` and attaching the token when present, following the existing `landing.js`/`ui.js` pattern exactly; an armed (login-configured) install is unaffected (`me.openInstallToken` is simply absent there). Re-verified live after the fix: Grant and Refuse both succeed, the pending count drops to 0, and the decided states persist across a reload — confirmed both at the DOM layer and directly against the store (`decidedBySurface: 'dashboard'`, `decidedByActor: 'operator'`).
- **#2625 (test-only):** `test/tmux-session-names.test.js`'s (#1983) scan for every test file that starts a real tmux session flagged `test/tmux-tcc.test.js`'s `startAuthorizedAnchor()` — its literal `'new-session',` array element matched the scan's `SPAWNS_TMUX` regex even though it targets the isolated `tmux.TCC_SOCKET` server, not the default one that scan tracks. GitHub Actions CI caught this on the Round 5 head; fixed by building the string from `['new', 'session'].join('-')` instead of a literal, with a comment explaining why.

<!-- prawduct: type=fixed | scope=w2c-2352-2625 -->

- **#2352:** `_persistedBridgeDecision` (`lib/permission-requests.js`) replaced its unanchored phrase-search-plus-negation-denylist with a single anchored, whole-message regex (`^\s*(?:yes\s*,\s*)?(grant|refuse)\s+<requestId>\s*[.!]?\s*$`, case-insensitive). TC-Lane-PRR-B's Round 5 review found the prior approach still granted a persisted question ("Can you grant perm_X?") or conditional ("If you want to grant perm_X, ask me first") — neither carries a negation word, so the denylist never fired, and the verb-adjacent-to-id check matched regardless of the surrounding prose. Anchoring the entire trimmed message removes the denylist altogether: any prose before or after the bare command fails the match, with no new keyword to enumerate against the next prose shape. `test/permission-requests.test.js`'s duplicate-external_id test (one route deciding two different requests) was restructured to update the SAME route's persisted body between the two `decideFromBridge` calls, since the anchored grammar correctly refuses a single message naming two decisions at once (the thing that test's old two-id-in-one-message fixture relied on no longer parses cleanly for either id, by design).

## 2026-10-27 — v5.40.0 W2-C PR #2637 Round 3 (PM re-dispatch): whole-message negation, word-bounded command, case-insensitive

<!-- prawduct: type=fixed | scope=w2c-2352-2625 -->

- **#2352:** Tightened `_persistedBridgeDecision` (`lib/permission-requests.js`) past the prior commit's adjacency-only negation strip, which still read "do not ever grant perm_X" (negation not immediately before the verb) or "DON'T grant perm_X" (case mismatch) as a grant. Now: any negation word (`not`/`no`/`never`/`don't`/`dont`/`cannot`/`can't`/`cant`/`without`) ANYWHERE in the message, case-insensitively, refuses the whole message as `PERMISSION_BRIDGE_DECISION_AMBIGUOUS` rather than trying to localize what it negates; the decision itself now requires an explicit `grant <requestId>`/`refuse <requestId>` adjacent phrase (word-bounded, case-insensitive, with a trailing lookahead so a longer id can't satisfy a shorter one's match) instead of the verb and the id merely appearing anywhere in the same message. The tmux.js default-server-probe fix from the prior commit needed no further change (confirmed accepted as-is). Dispatched directly by PM with the exact regex spec after TC-Lane-PRR-B's continued review; landed with unit + API negative tests for the negation-distance and case-mismatch cases.

## 2026-10-27 — v5.40.0 W2-C PR #2637 Round 3: negated decision words, and never probe an absent default server

<!-- prawduct: type=fixed | scope=w2c-2352-2625 -->

- **#2352:** `_persistedBridgeDecision` (`lib/permission-requests.js`) previously read "do not grant perm_X" as a grant, since `.includes('grant')` is true for it regardless of the "do not" in front. Fixed with `_stripNegatedDecisionWords` (removes a decision word immediately preceded by `not`/`never`/`don't`/`dont` before the grant/refuse check runs) plus word-boundary matching (`\bgrant\b`, so "regrant" no longer counts as naming "grant" either) — a negated or substring-only occurrence now correctly resolves to `PERMISSION_BRIDGE_DECISION_AMBIGUOUS`, never silently to the opposite of what was never explicitly said. Caught by TC-Lane-PRR-B's Round 3 review.
- **#2625:** `createSessionWithTccBootstrap` (`lib/tmux.js`) ran its starting-type readability probe (`new-session`) against the DEFAULT tmux server unconditionally — against an absent default socket, that implicitly starts one, and because a tmux server daemonizes independently of the short-lived client that asked for it, the newly-started (unprivileged) default server can survive even after the probe's own client call times out and gets killed. Fixed: a new `_tmuxServerRunning` presence check (generalized from the TCC-authorized-socket one added in Round 2, via `list-sessions`, which never starts a server) gates the default-server probe the same way the authorized-socket probe was already gated — an absent default server is read as "can't assume readable" without ever probing it. Also caught by TC-Lane-PRR-B's Round 3 review.

## 2026-10-27 — v5.40.0 W2-C PR #2637 Round 2: bind the bridge decision to the persisted message, bootstrap the TCC-authorized server via Terminal.app

<!-- prawduct: type=fixed | scope=w2c-2352-2625 -->

- **#2352:** `decideFromBridge` (`lib/permission-requests.js`) no longer takes grant/refuse from the caller-supplied `reply.decision` once the request id itself is proven — it now parses the ONE decision the persisted inbound message itself names (`_persistedBridgeDecision`: literal `'grant'`/`'refuse'`, same non-inferential check `_isAmbiguousBridgeReply` already used for the request id), refusing `PERMISSION_BRIDGE_DECISION_AMBIGUOUS` when the persisted text names neither or both, and `PERMISSION_BRIDGE_DECISION_MISMATCH` when it names the OTHER one than the caller claims. Caught by TC-Lane-PRR-B's Round 2 review: a persisted "refuse perm_X" reply was previously still appliable as a grant because the prior fix only checked that the decision WORD appeared somewhere in the text, not that it was the text's own, sole decision.
- **#2625:** `createSessionWithTccBootstrap` (`lib/tmux.js`) no longer calls `tmux -L tangleclaw-tcc-authorized new-session` unconditionally once the default server can't read a protected `cwd` — doing so against an absent socket silently starts an unprivileged, launchd-owned server on it, defeating the whole point of a separate authorized socket. It now checks the authorized server is actually running and can itself read `cwd` (`_tccServerRunning` + `probeTccReadable`'s new `options.socket`), and if not, bootstraps it inside a real Terminal.app window via `osascript` (`bootstrapTccAuthorizedServer`, injectable so tests never open one), re-probes once, and fails closed (throws) if the server still can't read the path. Caught by the same PRR-B Round 2 review.
- Confirmed already satisfied by the prior round: `public/session.js`'s pending-permission-request panel already rendered and HTML-escaped the stored `expectedAnswer`, with its own test — no change needed.

## 2026-10-27 — v5.40.0 W2-C: wire the TCC tmux bootstrap into the live launch path

<!-- prawduct: type=fixed | scope=w2c-2352-2625 -->

- **#2625:** `lib/sessions.js`'s real session-creation call site now calls `tmux.createSessionWithTccBootstrap` instead of `tmux.createSession` — the mechanism added in the entry below is live: a TCC-protected launch no longer hangs in production. Per Architect Ruling A475-W2C-R3 (authorizing `lib/sessions.js` into this car's scope, since no other active Wave 2 car touches it). Closes the follow-up filed as #2636.

## 2026-10-27 — v5.40.0 W2-C Chunks 02-04: permission-request routes/UI, Discord-bridge decisions, TCC tmux bootstrap

<!-- prawduct: type=feature | scope=w2c-2352-2625 -->

- **#2352:** The permission-request record now has an HTTP surface and a session-page UI (`lib/routes/sessions.js`, `public/session.{js,html,css}`): a verified project launch can ask for a scoped permission, the Operator sees pending requests on the session page and can grant or refuse them (CSRF-checked write proof), and a verified Master relay carrying a Discord-bridge reply can decide one too — `decideFromBridge` refuses a reply that does not literally name the exact request id (zero free-form inference), refuses an author who is not the pinned operator, and enforces that one bridge reply decides at most one request. Every real decision fires a best-effort, one-time Medusa receipt notice to the requesting session's live workspace; a session with no live listener gets the same receipt on its next read instead.
- **#2625:** Added the mechanism for a TCC-protected launch to bootstrap its real tmux session onto a separate, already-authorized tmux server instead of hanging (`lib/tmux.js#createSessionWithTccBootstrap`, fully tested) — **not yet wired into the live launch path** (`lib/sessions.js:872` is outside this car's authorized file scope; tracked as a one-line follow-up, not a silent gap).

## 2026-10-27 — v5.40.0 W2-C Chunk 01: permission-request schema foundation

<!-- prawduct: type=internal | scope=w2c-2352-2625 -->

- **#2352:** Added the durable permission-request record and its fail-closed state machine (`lib/permission-requests.js`): additive `permission_requests`/`permission_request_events` tables (`ensurePermissionSchema`, idempotent, no edit to `lib/store.js`/`lib/store/_schema.js`), lazy expiry (`PERMISSION_REQUEST_EXPIRED`) and launch-supersession (`PERMISSION_LAUNCH_SUPERSEDED`) transitions, and the shared `decidePermissionRequest` grant/refuse primitive (idempotent replay, `PERMISSION_DECISION_CONFLICT` on a conflicting decision) that the dashboard and Discord-bridge trust boundaries call once each has proven who is deciding. No route or UI surface yet — this chunk is the storage foundation only; `test/permission-requests.test.js` covers it.

## 2026-10-27 — v5.40.0 W2-A: the helper verifies its own posting destination, not just the bridge's (#2433, PR #2635, Architect Ruling A475-W2A-R4)

<!-- prawduct: type=fixed | scope=w2a-operator-bridge-dm-ingress -->

- **#2433:** The helper no longer posts an item to whatever `destinationChannelId` the bridge resolved without checking it first. `outbound.js`'s `relay()` now cross-checks the bridge's claim against this run's OWN verified local pin for that item's surface — the configured guild channel, or the DM channel this run's own startup check confirmed (`createOutbound`'s new `dmChannelId` param, wired from `cli.js`'s `allow` state). A surface with no verified local pin, or a named destination that disagrees with one, fails closed (`outbound-foreign-channel`) rather than posting on the bridge's say-so alone — closing the gap where a changed or unverified server-side pin could otherwise redirect a post. `bridge-gateway.js#_forHelper()` now also hands the item's own `surfaceKind` to the helper (previously only `destinationChannelId`), which this check needs to tell a DM item from a guild one client-side.

## 2026-10-27 — v5.40.0 W2-A: DM startup check no longer takes the whole helper down (#2433, PR #2635)

<!-- prawduct: type=fixed | scope=w2a-operator-bridge-dm-ingress -->

- **#2433:** `cli.js`'s startup DM-channel check (`verifyDmChannel`) called Discord's REST API with no `try`/`catch`; a 403/404 (channel revoked, bot removed) or a network failure threw uncaught, aborting `run()` before the guild gateway and outbound loop ever started — taking down the healthy guild surface over a DM-only problem, and skipping `lock.release()` on the way out (a leaked PID lock the next `run()` would have to out-wait). Now any thrown REST/network failure disables the DM surface alone, the same as a returned closed reason, and the guild surface starts normally. Also fixes `dm-surface-disabled-at-startup` never having been registered in `lib/bridge-helper/log.js`'s `CODES`, which silently rewrote every one of its log lines to `unknown-code` — the very code this fix's own log line depends on to say why DM was disabled. Found independently while verifying a third-party claim about this code path that turned out to cite an unverifiable approval; the claim's other half (a defense-in-depth re-check of the server-resolved `destinationChannelId` in `outbound.js`) was not implemented — it contradicts this module's own documented server-authoritative design and no independent Critic reviewer flagged it, so it is flagged for the Integrator/PM rather than built on an unverified say-so.

## 2026-10-27 — v5.40.0 W2-A Chunk 3: Operator Bridge DM surface panel, docs, and rollback (#2433 complete)

<!-- prawduct: type=feature | scope=w2a-operator-bridge-dm-ingress -->

- **#2433 (chunk 3 of 3, final):** The operator's global-settings panel gets a DM surface section (pin/enable, turn-off, pinned channel id) alongside the existing guild allowlist, and the configuration-circuit controls split into two independently resettable sub-sections — guild channel and DM surface — each passing its own `surfaceKind` through `operator/circuit/reset`. `docs/operator-bridge-helper.md` documents configuring and pinning the DM surface (both the helper's local config and the server-side allowlist must agree) and rolling it back alone (disabling DM without touching the guild channel, preserving DM routes/receipts, reconciling in-flight items before downgrade). This closes #2433: pinned DM ingress and source-bound replies now exist end to end — schema/inbound (chunk 1), per-destination outbound dispatch and failure isolation (chunk 2), and this operator-facing surface (chunk 3) — on one PR per Architect Ruling A475-W2A-R1. **Browser Check not completed:** the mandated Screens Isolation check (Rule #271 item 3) was attempted against an isolated scratch server but the Claude-in-Chrome browser extension would not connect; recorded as BLOCKED rather than skipped silently, with the user's explicit sign-off to proceed without it — see the build plan's Status section for the full account. The panel's logic remains covered by `node --test test/operator-bridge-panel.test.js` (jsdom-style lift), which is not a substitute for an actual rendered-browser check.

## 2026-10-27 — v5.40.0 W2-A Chunk 2: Operator Bridge per-destination outbound dispatch and failure isolation

<!-- prawduct: type=feature | scope=w2a-operator-bridge-dm-ingress -->

- **#2433 (chunk 2 of 3):** The helper now posts each outbound item to its own bound ingress surface's channel (resolved server-side, never left for the helper to guess), instead of the one fixed guild channel. The configuration circuit breaker is now scoped per surface (schema v70/bridge v65: `surface_kind` on `bridge_config_circuit`, its one-open-episode uniqueness rescoped from global to per-surface) — a DM channel outage no longer stops guild delivery, and the reverse, at both claim time (the SQL exclusion is per-surface) and within a single already-claimed batch (a circuit-classified post failure no longer aborts the whole relay pass; only items of the SAME destination in that batch are skipped). Disabling the DM surface holds its ready items for reconciliation without reposting them to the guild channel. `operator/circuit/reset` and `master/circuit/reset` take an optional `surfaceKind`. Outbound dispatch binding was the one piece chunk 1 explicitly deferred; the operator panel/docs/rollback instructions remain chunk 3.

## 2026-10-27 — v5.40.0 W2-A Chunk 1: Operator Bridge pinned DM ingress, schema and inbound half

<!-- prawduct: type=feature | scope=w2a-operator-bridge-dm-ingress -->

- **#2433 (chunk 1 of 3):** Schema v69 (bridge schema v64) adds `surface_kind` to `bridge_routes` and `bridge_outbound`, migrated via the bridge's own generic `upgradeBridgeTables` rebuild (existing rows default `guild-channel`). The helper's config (`dmChannelId`, `dmEnabled`), Discord REST (`getChannel` now reads a DM's `recipientId`), and preflight/startup (`verifyDmChannel`) gain the second pinned ingress surface: one type-1 DM channel from the same verified author, off by default. `inbound.js` accepts a matching DM alongside the existing guild channel, rejects every other DM shape (bot, webhook, group-DM, wrong author) before reading content, and replies refusals on the surface a message arrived on. Server-side, a new `POST operator/dm-allowlist` route and `bridge-gateway.js#acceptInbound`'s own independent allowlist check admit the DM surface in parallel with the guild one, deciding `surface_kind` itself rather than trusting the helper's say-so. `routes.accept()`'s existing replay-mismatch check now also catches a changed surface. Outbound dispatch binding to a route's surface (so a DM failure can never fall back to the guild channel) and the operator panel/docs are chunks 2 and 3, not in this PR.

## 2026-10-27 — v5.40.0 W2-D: records-only Tests: anchor verifier (P1)

<!-- prawduct: type=internal | scope=v540-w2d-p1-features-index -->

- **#2632:** `scripts/verify-features-index.js` no longer refuses a `Tests:` anchor newly added to `FEATURES.md` solely because the cited test file lands outside a records-only diff. When the whole diff classifies as docs/records-only (`scripts/docs-records-only-diff.js`'s roster), the citation is proven instead by checking the file exists on disk at `HEAD` and contains a real test registration (`it(`/`test(`) — a lightweight on-disk check, not a test run. Any diff that also touches an executable or test file keeps the original strict "must be touched by this diff" requirement, byte-for-byte unchanged. `.github/workflows/test.yml`'s Records Gate already calls this script on every docs-only PR, so the fallback is live immediately, not dormant code (Critic caught an earlier draft of this entry claiming otherwise — corrected). Filed #2632 to give this LANE_QUEUE-dispatched chunk a citable issue — the PM dispatch's suggested fragment name (`p1-features-index-records-gate`) wasn't a valid issue number for `changelog.d/`'s grammar.

## 2026-10-27 — v5.40.0 W2-B: session candidate-status read, and the #2133 duplicate closed

<!-- prawduct: type=added | scope=w2b-2133-2214 -->

- **#2214:** A session can now read what became of a candidate it submitted to the Project
  Master — `tc candidate status [<candidate-id>]` and `GET /api/bridge/session/candidates[/:candidateId]`
  — separating waiting, approved (ready/blocked), posted (with the Discord message id and
  parts), and discarded (rejected, withdrawn, expired, or merged with the survivor's own
  outcome). New `lib/bridge-candidates.js`, mounted in `server.js` right after the
  `bridgeApi.ROUTES` loop; reads `bridge_candidates`/`bridge_outbound`/`bridge_outbound_parts`/`bridge_audit`
  directly, with zero changes to `lib/bridge-api.js` or `lib/bridge-store.js` (A475-W2-PACK).
- **#2133:** Closed as a duplicate, not rebuilt — the wake-Master-on-submission behavior it
  asked for already shipped under #2547 (commit `8343e1c5`, `_tellMasterOfCandidates()` in
  `lib/bridge-gateway.js`'s tick pass). Verified end to end alongside #2214 in
  `test/bridge-candidates.test.js` (Architect Ruling A475-W2B-R2: no second, parallel notify
  mechanism was built, so the one source of truth can never double-notify or race).

## 2026-10-27 — v5.40.0 W1-A: operator-needed alert context and Gateway resume docs

<!-- prawduct: type=changed | scope=v540-w1a-2141-2334 -->

- **#2141:** `operator-needed` Discord alerts now name the sender, priority, age and exchange id instead of a bare recipient-only sentence, and are suppressed for an opted-out recipient or one whose `coordinatorProject` has a live session — the same opt-out and coordinator-first suppression `work-blocked` already had (#2620). A `work-unblocked` recovery notice is now raised once its block notice is actually `delivered` to Discord — never while that notice is still queued, set aside, or was let go uncollected or withdrawn, and never when a newer block has already superseded the clearing (Architect Ruling A475-W1A-R1: it rides under `work-blocked`'s own admitted `notify_type` and retention in `bridge_outbound`, so no schema migration was needed).
- **#2334:** Documented the Discord helper's periodic Gateway resume (`gateway-connecting` to `gateway-resumed` in about a quarter second, no `gateway-closed` line, no event lost) as Discord's own documented op 7 Reconnect, not an outage or a defect.

## 2026-10-27 — v5.40.0 W1-D: Master Medusa reply deadlocks

<!-- prawduct: type=fixed | scope=w1d-1988-2176 -->

- **#1988:** `exchangeCaller()` had no branch for a verified Master launch, so
  every Master caller fell through to `unbound` on the send route and a
  reply carrying `inReplyTo` was refused before `REPLY_TARGET_UNKNOWN` was
  even reached. The Master's verified launch now binds a reply, narrowly
  (not folded into `boundSender`, so it gains no `blocking`/`critical`
  priority).
- **#2176:** The wake nudge told a read-only Project Master to POST a reply
  its own access level refuses (403 `ACCESS_LEVEL`). It now reads the
  Master's current access level per nudge and, when read-only, tells it to
  describe the needed reply for the operator instead — per Charter A475
  line 41's ruling not to widen the Master's outbound authority as a side
  effect of the wording fix.

## 2026-10-27 — v5.40.0 W1-B: update rebase-onto-tag and Medusa Bridge fail-closed

<!-- prawduct: type=feature | scope=v540-w1b-2399-2354 -->

- **#2399:** The in-app update now rebases a checkout's local commits onto the latest release tag instead of refusing outright, when the branch's fork point from `main` is reachable from that tag. A rebase conflict aborts cleanly and refuses with the conflicted files named; every other branch shape keeps the existing `wrong-ref` refusal.
- **#2354:** An explicit `MEDUSA_BRIDGE_WS_URL` that the resolver refuses (unparseable, wrong scheme, a fragment, a non-loopback host) now fails closed — no session listener starts, and its status names the refused value and reason — instead of silently falling back to the default Bridge. A derived or unset WS URL is unaffected.

Dispatch (mx_4d00fbbd / PM) named `lib/updater.js`, `routes/update.js`, `test/updater.test.js`, `test/medusa.test.js`; none exist in this repo. Corrected scope confirmed by PM (mx_0M9uk1K0QYRtpeWD): `lib/update-applier.js`, `lib/medusa.js`, `test/update-applier.test.js`, `test/api-medusa.test.js`. Critic also required touching `lib/medusa-listener.js` (new `WS_URL_REFUSED` code), `public/api-helper.js` and `public/update-beacon.js` (surfacing the new codes to the operator), `public/session.js` and two docs (`docs/configuration-reference.md`, `docs/adr/0010-one-update-mechanism.md`) to keep existing contract tests and documentation accurate.

## 2026-10-27 — v5.40.0 W1-C: Master shared-doc notices and stale-coalescing fix

<!-- prawduct: type=feature | scope=v540-w1c-2350-1084 -->

- **#1084:** The Project Master now receives shared-doc change notices when it is listening and its configured scope covers the doc's group — best-effort, coalesced the same way a project session's notice is.
- **#2350:** Coalescing an un-handled notice no longer hides a reader going silent forever: past a 10-minute staleness bound the next write sends anyway instead of coalescing, and a warning names the doc and session so the gap is visible before it reaches hours.

## 2026-10-26 — v5.39.0 W1-B: CI evidence and mandatory fragments

<!-- prawduct: type=internal | scope=v539-w1b-2371-1220 -->

- **#2371:** The lane host now declares the suite-evidence wrapper as its test command. The Tests workflow uses a short Records Gate for docs, records, and release-metadata-only PRs, while code diffs still run the full suite. The directory-scanner fixture's child process now exits on IPC disconnect.
- **#1220:** Code PRs must add a `changelog.d/` fragment or state `Changelog: none <reason>`; CI enforces the rule after the pre-boundary PRs, including #2523, closed.

PR #2619 merged at exact reviewed head `02eefa96` as `8091fce1`.

## 2026-10-26 — v5.39.0 W1-C: dead exports and status counts

<!-- prawduct: type=internal | scope=v539-w1c-2607-747 -->

- **#2607:** Removed 51 unused public exports, leaving three documented audit exceptions in `test/dead-exports-baseline.json`.
- **#747:** `refreshStatusBars` now counts its skip reasons at their outcome sites and returns the breakdown; two source-shape tests now run the lifted functions.

PR #2618 merged at exact reviewed head `6030e503` as `c237ede6`.

## 2026-10-26 — v5.39.0 W1-INT: live wrap verification

<!-- prawduct: type=internal | scope=v539-w1int-2588 -->

- **#2588:** An isolated scratch-server and headless Chromium run exercised the real session wrap UI: the review checkbox produced a `needs-operator` pause before commit, Keep local and Retry sent `pathDecisions[path] = 'leave'`, and the second run completed without another pause or commit. The file remained local and the issue closed after the live receipt.

## 2026-10-26 — v5.39.0 W2-B: Master controls, paste evidence, and coordinator alerts

<!-- prawduct: type=fix | scope=v539-w2b-2035-192-2620 -->

- **#2035:** Full screen and Pop out are available for Project Master in both the dashboard panel and session drawer through one shared control bar.
- **#192:** Raw-mode tmux PTY and browser-side `term.paste()` regression tests pin multi-line Master paste framing and byte-for-byte payload delivery; no production paste change was required.
- **#2620:** Direct Discord work-blocked alerts are suppressed for an opted-out project or a sub-lane with a live coordinator, leaving escalation to that coordinator.

PR #2621 merged at exact reviewed head `46f88c626b0a57bf40256710bceb2063fbdbe324` as `7158607180c4c442adb569c568ddb14db8e365af`. Exact-head Tests run `40400670019` succeeded; the CI-mode recorder reported 23,452 JUnit leaves and 0 failures. PRR-A and Architect A474-W2B accepted the exact head.

## 2026-10-26 — v5.39.0 W2-C: session controls and terminal recovery

<!-- prawduct: type=fix | scope=v539-w2c-1317-960-1237-1638-2011 -->

- **#1317:** The wrapping status dot now uses the dashboard's spinning pinwheel.
- **#960:** Removed the session banner Select button, its mouse-mode flip, and abandoned-mode recovery; ordinary selection and the touch long-press Copy pill remain.
- **#1237:** A rejected mouse-mode Settings save restores the prior state and surfaces its failure.
- **#1638:** Touch terminals have an Esc, Ctrl, Tab, and arrow keybar; sticky Ctrl applies to the next keystroke without replacing ttyd's xterm handler.
- **#2011:** The terminal reattaches after a session restart and recovers from a positively detected ttyd disconnect with bounded retries. An unreadable frame alone does not trigger a retry.

PR #2622 merged at exact reviewed head `89dab7661d7a0c521420f5ed921ee930e4e48cb2` (tree `4702ce2a12009942ae8d71c4d54e4089e9e25ea1`) as `29ec322d7599eeeb0b5789492e8b2e8971ad40f5`. Exact-head Tests run `40416661372` succeeded; the CI-mode recorder reported 23,493 runner tests / 23,488 JUnit leaves, 0 failures, and matching Prawduct evidence tree. PRR-B Rule #286/#81 and Architect A474-W2C-ACCEPT-R3 accepted the exact head. All five linked issues closed on merge.

## 2026-10-25 — v5.38.0 W3-A: create setup, shared lease-ignore, and project path health

<!-- prawduct: type=fix | scope=w3a-1304-1382-2401 -->

- **#1304:** Creating a project opens Settings before the first session launches. Save & Launch starts with the chosen settings; Save and Cancel keep the project without launching.
- **#1382:** Port-import Ignore choices persist in server config instead of per-browser localStorage, so they carry across devices.
- **#2401:** Unarchive refuses a missing or empty seeded project path until the operator confirms a fresh start. Launch carries an advisory path-health warning to the session view so it remains visible after navigation; launch itself is not refused.

PR #2615 merged as `d3eee9b749eb5f0dc2d4964ed0dd8af2d1e8eebc` from exact head `57acccba3c305a55de3f37a924874ef1bd726a01` (tree `f20ecc5614255e7e40a402e6736e40e409c73a35`) after PRR-A final ACCEPT. Exact-head Tests run `40272409168` and latest-main Tests run `40258598329` succeeded. The CI-mode recorder accepted that head and tree with 23,400 runner tests, 0 failures, and valid Prawduct evidence; A473-A8 co-signed the final 22-file scope, including the session-view warning handoff.

## 2026-10-25 — v5.38.0 W3-B: needs-operator wrap verification

<!-- prawduct: type=internal | scope=w3b-2588-wrap-needs-operator -->

- **#2588:** Added `test/wrap-needs-operator-live.test.js` against an isolated server and real wrap pipeline. It verifies the pre-commit `needs-operator` pause, the owned file on `manifest.commit`, and a Keep-local Retry that moves the file to `manifest.keepLocal` without a second pause or commit. A VM-mounted test runs the real drawer-row renderer and `retryWrap` accessor/POST with a lightweight DOM. The required manual live-session browser click and visual check remain open under #2588.

PR #2613 merged at exact head `cce1034d6484fc40dd63d40723fdc52b96f1b1da` (tree `b40eb9c2388abed0118861585cd8731f308194d0`) after PRR-B final ACCEPT and Tests run `40257249671` SUCCESS. The CI-mode recorder reported 23,367 tests, 0 failures, and tree-valid Prawduct evidence; A473-A6 co-signed the five-file scope. `test/_mini-dom.js` gained the checkbox, selector, and text-node support used by the new UI test.

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
