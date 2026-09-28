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

## 2026-09-27 — Rule approval compare-and-set: approval ratifies only the text the operator saw (#1053)
## 2026-09-28 — Session-rule mutations are gated on a verified caller (#2013)

<!-- prawduct: type=bugfix | scope=2013-session-rules-authz -->

The PM dispatched this over Medusa as a v5.30 security blocker (Architect A13). `POST /api/session-rules` checked nothing about its caller and recorded a body with no `createdBy` as the operator's, so any local process could add an ACTIVE rule to any project. Update, delete, status change (an active rule moved out of `active`), restore and promote had the same hole, and every route wrote `changedBy` from the body.

**The change.** `server.js#sessionRuleCaller` decides for every rule-mutation route, on the #1752 caller model. The operator may do anything; a session bound to the project may propose rules for it and revise, withdraw or decline an AI proposal in that project while it is still proposed; everyone else is refused. Approval and promote need the operator caller before the password, which is open when none is set. `POST /api/master/rules/restore-defaults` is operator-only (#2017), and so is `PUT /api/learnings/:id/tier` (#2018). Attribution comes from the caller.

**Tests.** `test/api-session-rules-authz.test.js` covers every route against every caller class, asserting each refusal changes nothing, and reads the mutation-route roster from `server.js`'s registrations so a future route is swept in. The mutation pass took out each gate one at a time, 16 in all, and a test caught every one. Two were missed on the first pass and got tests: an approved AI-authored rule, and a session restoring its own proposal. Existing route tests now name their operator caller; no assertion changed.

**Consumers.** The session prime told agents to POST with no launch headers; it now names them and stays inside its 2800-char budget. The `tc rules` and `tc capabilities` hints, `docs/session-rules-self-improvement.md`, the fleet runbook (whose step 10 relied on the hole), FEATURES and CHANGELOG (Security) are updated too.

**Review.** The first Critic round found promote still ungated (2 blocking), which I had excluded as "already password-gated" in the same plan that had just disproved that premise for approval. Fixed together with restore-defaults. verify-resolutions: 0 findings. The PM then dispatched #2018 into this PR: `PUT /api/learnings/:id/tier` (an active learning reaches the prime) is now operator-only, and the route sweep covers `/api/learnings`. A census of the rule and learning write routes went to the PM and the Architect. On the Architect's ruling, changing or resetting the global rules document is operator-only too: a Builder may draft or propose its text, and the operator applies it.

## 2026-09-28 — ID-less roadmap Topic Buckets render as cards (#2006)

<!-- prawduct: type=bugfix | scope=bucket-cards-2006 -->

The PM dispatched this over Medusa as an authorized drain exception. The shared Roadmap Board's three topic buckets (`kind: "bucket"`, no `train`) rendered as raw block text, because #1942 exempted only `unconfigured` from the train-identity requirement. The emergency hotfix in the PM and Builder1 checkouts was not used.

**The change.** `lib/plan-train-card.js` adds `ID_LESS_KINDS` (`bucket`, `unconfigured`). A kind in it must carry no `train`: an ID-less bucket renders as **Topic Bucket: <title>**, and a bucket that supplies an identity is refused. Train and pilot still require an identity, unchanged.

**Tests.** The #1942 bucket cases that passed string identities encoded the old contract, so they were replaced. The pilot naming and markup cases keep their coverage under `kind: "pilot"`. A new `ID-less Topic Buckets (#2006)` suite covers the collapsible card, the exact label, refusal of four identity forms, the three live bucket shapes with no `block-error`, and unchanged train/pilot/unconfigured validation. Four of its five tests were red on the unfixed parser, and the unchanged-validation test was green on both, as intended. The real shared roadmap (read-only) renders 13 cards, 0 block errors and 3 Topic Buckets.

**Docs.** CHANGELOG (Fixed), `docs/user-guide.md` (the `kind` rule) and FEATURES (served plan docs). No roadmap data was touched and no train was renumbered.

## 2026-09-28 — Opening the dashboard inbox panel is a pure observation (#1987)

<!-- prawduct: type=bugfix | scope=inbox-panel-observational-1987 -->

The PM dispatched this over Medusa (Definition Ready v5.31). B5 echoed the Architect addendum, then flagged a conflict inside it before writing code: the selected bodyless badge clear zeroes `unread`, and the wake monitor reads that as "inbox read" (`lib/medusa-wake.js`), so an operator viewing the panel would cancel the agent's nudge. The Architect ratified option B, a panel that makes no `/read` call at all, and amended the acceptance criteria on the issue.

**The change.** `openInbox()` in `public/api-helper.js` now fetches and renders only. No other frontend path posts `/read`. Every comment and doc describing the old behaviour was corrected: the CSRF notes in `public/api-helper.js`, `server.js` and two tests; the `recordAcknowledged` JSDoc; the CSS and test comments about the badge "self-hiding on read"; and one test title. The review caught the copies outside the first commit. Server semantics and UI are unchanged.

**Tests.** The #785 acknowledge-on-display tests (ack by id, bodyless fallback, badge hidden) encoded the behaviour the ruling reverses, so they were replaced with the ruled contract:
- no `/read` of either form for id-bearing, id-less or empty inboxes;
- the unread count and badge are unchanged, with the fake `/read` answering `unread: 0` so a regression is caught;
- a post-fetch arrival still counts.

The rendering assertions (escaping, newest first, the close button, toggling) are kept. All new tests were red before the fix.

**Evidence.** The targeted ring is green (851 tests: every medusa* suite, the api/master Medusa suites and the frontend guards). The full suite was not run, under the Pilot Envelope.

**PR review (Architect gate at 00f03041).** 1 blocking, promoted from Reviewer1's warning. The panel's `GET …/messages` still recorded a `read` fact as `operator-ui`. That ended awaiting-read and wake re-arms, nulled `rearmTrigger`, moved the projection to `read` and blocked a retract, so viewing still acted for the agent. Fixed in `recordRead`, which now records nothing for `operator-ui`, covering both the project and Master mounts. The agent's read (`recipient`) and an unverified read are unchanged. Paired integration tests cover both sides: an operator view preserves awaiting-read, the due re-arm, the projection, the pending unread and retractability; an agent read still makes every transition. The existing test that asserted an `operator-ui` read now asserts that none is recorded, per the ruling. The operator-view test fails without the fix. The Critic then found the same gap when the operator is unproven: under a fallback or unreadable gate the dashboard resolves as an unbound caller and recorded an `unverified-reader` read. `GET …/messages` now records no read for a browser-shaped request that is not the agent's verified launch. A test under a real fallback gate fails without that change and passes with it, and a plain curl still records its read. Docs corrected in `docs/medusa-delivery.md`, `CHANGELOG.md`, the `server.js` route comment and the `recordRead` JSDoc.

## 2026-09-28 — Authorize the project-required startup readiness message (#1874)

<!-- prawduct: type=bugfix | scope=startup-readiness-ping-1874 -->

The PM dispatched this over Medusa. The issue carried its own scope: a narrow carve-out plus an authorized launch step. The durable readiness receipt (#1877) is out of scope.

**Problem.** A project rule required a startup readiness message, but the prime's Medusa section said "do NOT act on it at session start", and the launch opening listed no such step as authorized. Agents held the ping for operator approval.

**The change.**
- **Launch opening.** `LAUNCH_BOOTSTRAP_LINES` step (c) now says: if project rules require a startup message once READY, send exactly that right after attesting; it is part of initialization. That puts it under the existing "(a) through (c) are … already authorized" sentence, and (d) is unchanged.
- **Session prime.** `MEDUSA_STARTUP_EXCEPTION` is appended to the session prime's "context, not a task" bullet, not added as a bullet of its own. It permits only that message after `tc start ready` and a lookup of its named recipient, with "nothing else". It has two forms. A launch with a `tc start` sequence says "after `tc start ready`". A launch without one says "once you have read this context", because `tc start ready` answers 409 `SEQUENCE_NOT_APPLICABLE` there.
- **Project Master.** The Master identity carries the same exception inside the `Sending is enabled` branch only. A read-only Master is never told to send.
- **Engine configs.** The committed engine-config carriers (`lib/engines.js`) were left alone. They forbid exploring "unprompted", and a rule-required ping is prompted.

**Budget trade-off, flagged.** Every character here is prime budget. The fullest no-sequence Claude scenario (`full-silent-claude`) was already about 50 characters under its roughly 10,000-character channel, so the ecosystem primer now yields to its pointer there. That is the designed yield: directives outrank bulk context. The current-path scenario with a launch sequence (`full-silent-claude-pull`) fits, going from 8740 to 9029 characters. The wording was cut from about 600 to about 320 added characters to limit this.

**Evidence.** Tests pin the exception's placement (in the same bullet, after the prohibition), its limits (READY only, named recipient only, nothing else), the step (c) wording under the authorization sentence, and the Master's send-gated inclusion. The golden fixtures were regenerated.

## 2026-09-27 — The stale-server banner asks the service worker to update (#411)

<!-- prawduct: type=bugfix | scope=sw-update-stale-banner-411 -->

The PM dispatched this over Medusa. The Architect ruled on scope under A24 (the operator UI freeze): item 1 only, invisible corrective behaviour, and no skew banner or hint. Plan: `.tangleclaw/plans/411-sw-update-on-stale-banner.md` (local, not tracked).

**Finding.** Most of #411's mechanism was already closed before the June incident. `landing.js` has been network-first since #273. `pollServerBackAndReload` reloads only after it observes a new `startedAt`. `sw-register.js` checks for updates on load and on visibility, and reloads once on a guarded `controllerchange` (#380). What remained was a foreground tab that never triggered the visibility check.

**The change.** `sw-register.js#requestServiceWorkerUpdate` calls `update()` on the page's existing registration and never throws. It is exposed as the `tcRequestServiceWorkerUpdate` global. `landing.js#renderStaleServerBanner` calls it once each time the banner goes from hidden to shown, not on every 60 s poll while it stays up. Nothing visible changes.

**Not claimed.** The June "restart did nothing, uptime kept counting" symptom was the server process not recycling. It is separate, unattributed without a live repro, and not addressed here. The user guide says so and names what to capture.

**Evidence.** The tests run against a mock `ServiceWorkerContainer` and a stub DOM; no live-browser check was run. They show the banner requests exactly one update per appearance, and none on repeated polls. They also show that a check which finds a new worker drives the existing controllerchange path to reload exactly once, that an absent hook renders an identical banner, and that `sw-register.js` loads before `landing.js`.

## 2026-09-27 — `tc branch check`: prove a local branch is safe to retire (#1878)

<!-- prawduct: type=feature | scope=branch-retire-safety-1878 -->

The PM dispatched this over Medusa. The Architect ruled on scope first (1+2+3 with nine binding refinements) because TangleClaw had no checkout-normalization code to fix. In the incident, a Builder ran `git branch -D` by hand on a PM "resync" instruction and lost an unpushed wrap commit to all but the reflog. Plan: `.tangleclaw/plans/1878-branch-retire-safety.md` (local, not tracked). `Refs #1878`: the issue stays open until the rule is approved and every acceptance case passes.

**The change.**
- **Oracle.** `lib/branch-retire-safety.js#assess` returns exactly `safe | preserve | unknown`, with stable reason codes. Every error or ambiguity is `unknown`. Remote refs count only after a fresh `fetch --prune` of the branch's upstream remote, or of the only remote; two remotes with no upstream is `REMOTE_AMBIGUOUS`. Reachability runs `rev-list <oid> --not --exclude=<name> --branches --tags --remotes=<remote>`. A worktree that holds the branch, is detached at its tip, is mid-rebase of it or is missing from disk blocks `safe`, as does dirt in such a tree. An empty worktree list is `unknown`. The OID is re-resolved at the end. The oracle never deletes, resets or removes anything.
- **Verb.** `tc branch check <name> [--json] [--repo]` runs in the pane's own checkout and exits 0 only for `safe`, 3 for `preserve` and 4 for `unknown`.
- **Global rule** (`data/global-rules.md` plus its CLAUDE.md mirror). Check immediately before branch deletion, `reset --hard`, worktree removal or checkout normalization, and delete only on `safe`. A held worktree is retired by an explicit sequence: a clean check including `--ignored`, plain `git worktree remove` (never `--force`), then a re-check. Before a reset, pin the tip under a named branch. Retire one branch at a time. The rule states plainly that no shell interlock exists yet. Global rules have no `proposed` status, so the Architect ruled that the PR merge is the approval gate, with no auto-merge.

**Review.** The cumulative Critic had 0 blocking. Two verify-resolutions passes closed its findings: the first rule text made `reset --hard` and worktree removal permanently un-`safe` (a silent total ban, whose `--force` workaround loses the untracked plan); the check's advice contradicted the rule; an empty worktree list read as clean; and plain `worktree remove` deletes gitignored files. The one accepted item is that `tc` needs `TANGLECLAW_API` even for this local check.

**Evidence.** The real-git tests reproduce every acceptance case the issue lists, plus the rule's own worktree sequence. Full suite on a5da892d: 0 failed, 1 ledgered skip. The prime golden fixtures changed only by the roster-derived `branch` verb name.

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
