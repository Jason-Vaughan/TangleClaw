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

## 2026-10-16 — #2223, #2142: the Codex folder-trust timeout route is driven end to end; a missed local trust anchor says what was wrong with each directory

<!-- prawduct: type=bugfix | scope=w4b1-codex-timeout-route-and-trust-anchor-reasons -->

v5.34.0 Wave 4 chunk W4-B1, its one chunk. Branch `fix/w4b1-codex-timeout-route-and-trust-anchor-reasons` from `94e48d31`. Refs #2223, #2142 (the PR body carries the closing keywords). Plan: `.tangleclaw/plans/build-plan-w4b1-codex-timeout-route-and-trust-anchor-reasons.md` (rev 2, sha256 `191ca435…49bd7`; charter v2.9, sha256 `1fddcb23…c643e`; Architect A128, Option A). Exactly the seven locked files.

**Why (#2223).** Codex declares no startup dialogs, so its launch goes straight to the readiness gate, which never sees `· Ready ·` while the folder-trust dialog is up and gives up after 90 s. What happened next was covered piece by piece but never through the launch path, because a wiring test seemed to need a 90 s wait or a timing seam.

**What (#2223).** No production change (Option A: charter v2.9 replaces the v2.8 seam requirement). New `test/codex-readiness-timeout-paste.test.js` drives the bundled Codex profile through `_deferEngineInit` at the gate's production 750 ms / 90 s timing, with `setTimeout` and `Date` mocked; the shipped 90 000 ms and 750 ms are pinned as literals, so drift in both constants together fails the test. On a dialog that stays: nothing typed, no raw key, one `prime-paste` row `skipped` naming the folder-trust prompt, written at the horizon (elapsed fake time asserted), and the guarded-dialog warning logged once at the first capture's fake time. On a dialog that is answered: one paste, row `delivered` before the horizon.

**Why (#2142).** On an HTTPS install with no anchor, the hook sends the operator to a server log line whose `caroots` field was a fixed string, and `localTrustAnchor` returned one null for every cause. A supported public or custom certificate also warned, and could spawn `mkcert -CAROOT`, on every hook sync. The hostname check and the `[::1]` arm had no test that could fail.

**What (#2142).** `lib/https-setup.js`: new `localTrustAnchorSearch(config, opts)` returns `{caFile, tried, fingerprint, certError}`, one `tried` entry per directory with its source and reason. `localTrustAnchor` returns its `caFile`, unchanged for every existing case. Only the search's fallback `mkcert -CAROOT` answer is remembered per process (`detectMkcert` is unchanged); `$CAROOT` and the default are read fresh; `opts.mkcertCaroot` and `opts.env` are injectable and `_resetMkcertCarootMemo` resets it. `lib/sessions.js` `syncControlHooks`: the warning lists each directory and reason, at `warn` once per certificate fingerprint and reasons per process and at `debug` after (`_resetTrustAnchorWarnings` for tests); the marker and trust decision are computed fresh each call. `lib/control-hooks.js`: the header points at `install()` for the marker's fields (comment only). `docs/control-state.md`: the log line, its levels, and the restart needed to see a later mkcert install.

**Tests.** `test/control-hooks-https.test.js` gains: the per-directory reasons (absent, unreadable, not a certificate, other issuer, unset, repeat, unreadable served certificate); the fallback asked once across misses and again after a reset, counted through a stand-in `mkcert` on PATH; warn then debug on a repeat, again on a changed reason or certificate, with the marker and `localTrustAnchor` identical, and a hit found at once after a miss; and leaves naming only `DNS:localhost` or only `IP:127.0.0.1` (with a CN that names neither, since Node checks the CN when there is no DNS SAN), plus `[::1]` with the default and the DNS-only leaf. The `[::1]` stubs reject on a failed bind, so that arm fails rather than skips. Its existing assertions are unchanged; the stub helper takes a listen host and `makeLeaf` an optional SAN and CN. Mutations checked by hand and reverted: removing `servername`, bypassing the identity check, and removing or narrowing the warning memo's key each fail a new case.

**Not checked:** a refused governed commit on the deployed HTTPS install; whether GitHub's runner binds `::1` is known only when CI runs.

## 2026-10-16 — #2317, #2375: the prime states no rule count a clear would make stale; the recorded-launch-command judgment moves to a store-free module

<!-- prawduct: type=bugfix | scope=w3b2-prime-rule-count-and-recorded-command-module -->

v5.34.0 Wave 3 chunk W3-B2, its one chunk. Branch `fix/w3b2-prime-rule-count-and-recorded-command-module` from `fb7f79fa`. Refs #2317, #2375 (the PR body carries the closing keywords). Plan: `.tangleclaw/plans/build-plan-w3b2-prime-rule-count-and-recorded-command-module.md` (rev 3, sha256 `0ef9f962…70ec18`; charter v2.8, sha256 `f563e277…69b67`; Architect A109 and the rev 3 acceptance, Option A). Exactly the 22 locked files, of which 18 change; items 10, 12 and 13 (`session-rules-channel`, `session-rules-refresh` and `self-improvement-loop` tests) and `bin/tc` needed no change.

**Why (#2317).** The prime is written once at launch, and a `clear` or `compact` fire prints it again as written, beside a rules block read at the fire. Its manifest, its pull pointer and its rule-sources line carried the launch's rule count, so the two disagreed once a rule was activated or retired. A launch with no rules said "none active for this project", which a later rule would contradict in the same way.

**What (#2317).** `lib/sessions.js`: the manifest and the pull pointer say "Operator-authored rules govern this session" and name the **Project Rules** block as stating which rules are in force and how many. The rule-sources line reads "startup rules for this project, as the rules block lists them, delivered <channel>.", and with no rules "none were active when this session launched; a **Project Rules** block in your context, if present, is in force." The absence checks, the inline floor, the delivery ledger and digest, and the launch step's governance text are unchanged.

**Why (#2375).** `tc` judged its own pane by lazily requiring `lib/startup-control-codex.js`, which loads the store. So it hid node's `node:sqlite` ExperimentalWarning with a wrapper, `_requireQuietly`, and kept its own copy of `_withoutPathFloor`, because `lib/sessions.js` loads the store too.

**What (#2375).** New `lib/recorded-launch-command.js` (requires only `node:path`) holds `judgeRecordedCommand`, the helpers it uses (`_leadingExecutable`, `_readArguments`, `_launchesCodex`, `_shellWord`, `SAFE_PATH`, `ENGINE_BINARY`, `PLAIN_ARGUMENT`) and `_withoutPathFloor`. The nine blocks are byte-identical to `fb7f79fa`, with only JSDoc links to their old neighbours spelled as paths. `lib/startup-control-codex.js` and `lib/sessions.js` require and re-export them, so the launch judgment and every caller use one definition. `lib/tc-verbs.js` requires the module at the top; its copy, its lazy require and `_requireQuietly` are gone.

**Tests.** New `test/recorded-launch-command.test.js`: the module loads no other `lib/` file and `tc`'s judgment path loads neither the store nor the adapter, both checked in a fresh process; one definition throughout; the judgment's answers; and the floor cases from the removed copy test, with their expected outputs. New `test/prime-rule-count-after-clear.test.js`: no count on the hook, pull and inline channels; a `clear` re-delivery of a 3-rule prime beside a 7-rule block states no disagreeing number; the no-rules wording. It fails all five on `fb7f79fa`. `test/tc-pane-identity.test.js`: the two-copies test becomes one-definition, and the `_requireQuietly` tests go with the function. Sentence pins are updated in `test/sessions.test.js` and `test/session-rule-delivery.test.js`. Length-dependent setups, with no assertion changed (rev 3): the seven prime goldens regenerated, with the diff confined to the three sentences; the #1888 cap-fill loop in `test/prime-hook-output.test.js` given a finer step (its old ~263-char steps jumped past the cap once the floor grew); `TIGHT_BUDGET` 3000 → 3100 (floor 2951 → 3034); and the #557 trim case moved onto its own project, because earlier cases leave stranded-wrap state on the shared `prime-test` project. Its room is now 1078 in full-file order and 1081 isolated, against a 966 trim threshold.

**Not checked:** a live clear on the deployed install with a changed rule set (owed after the deploy, owner TC-Lane-B); `tc` start-up time saved, not measured.

## 2026-10-16 — #2339, #2313: a refused launch's message stays until dismissed; the bridge's Discord times in host-local time

<!-- prawduct: type=bugfix | scope=w3b1-refused-launch-toast-and-bridge-local-times -->

v5.34.0 Wave 3 chunk W3-B1, its one chunk. Branch `fix/w3b1-refused-launch-toast-and-bridge-times`. Fixes #2339. Refs #2313, which stays OPEN until one signed-in screen check after the deploy (the PM's deferral, below). Plan: `.tangleclaw/plans/build-plan-w3b1-refused-launch-toast-and-bridge-local-times.md` (rev 6, sha256 `e3f5dd80…cb2720c`; charter v2.7, sha256 `5b7d2550…912a1bc1`; Architect A110, A111, A116, A117, A120, A121 and the R-2 Escape correction). Exactly 23 files.

**Why (#2339).** The dashboard shows every message in one toast, and each site set its own hide timer that nothing cancelled. A refused launch was hidden after six seconds, or sooner by an earlier message's timer, and in that case its "Open launch isolation settings" button stayed in the off-screen message, in the tab order. Refusals are long sentences carrying an absolute path, and the toast did not break a long word.

**What changed (#2339).** `showToast` in `public/ui.js` is the toast's one owner, with a new `hideToast`: each message cancels the timer of the one before and removes what it added; a timed message hides itself without calling out, so it can still be lifted alone. Every direct toast write in `public/landing.js` and `public/ui.js` calls it. Both launch-failure branches are sticky: no timer, a Dismiss button, Escape with focus in the message; a newer message replaces one (the Integrator's ruling). The pointer's wordings (the decider's rulings item 61) now say the button goes when the message is dismissed or replaced. `.toast` gains `overflow-wrap: anywhere` in `public/style.css` and `public/session.css`; the message's buttons take their own line. The session page's message lifetimes are not changed.

**Why and what (#2313).** The bridge panel and `tc bridge status` printed the helper's Discord times as raw UTC ISO. Both status routes in `lib/bridge-api.js` now add `sinceText` and `reportedAtText` to `discordGateway`, worded by the notices' own formatter (`lib/bridge-notify.js` exports `_when` as `when`, unchanged): `22:03 PDT on 2026-10-10`. The ISO fields are unchanged for scripts. `public/operator-bridge-panel.js` and `lib/tc-verbs.js` print the words and fall back to the ISO time from an older server. The configuration circuit's times stay raw ISO, out of scope by ruling.

**Docs.** Three docs described the old behaviour and are corrected (charter v2.6 and v2.7): `docs/operator-bridge.md` (the status's field list, the `tc bridge status` line templates, and the dashboard panel's table and the paragraph above it), `docs/user-guide.md` (the Codex refusal entry no longer says the message shows for six seconds only) and `docs/engine-guide.md` (the override's pointer-button sentence).

**Deferred, not a blocker (the PM's approval, rule 264.3).** The signed-in Operator Bridge panel's Discord line in host-local time was not seen on screen: the scratch server's bridge routes need a signed-in account and no credential is entered on a non-local host. Before the merge it is held by tests (the real panel against the real status route, and the real `tc bridge status`, zone pinned). Owed after the next deploy, owner TC-Lane-B, in LANE_QUEUE "Waiting on the next deploy".

**Tests.** New: `test/launch-refusal-toast.test.js` (the real functions with held timers: both branches stay, Dismiss and Escape, the overlap case, replacement, the source layout) and `test/bridge-status-timestamps.test.js` (the formatter, the real `bin/tc` against a stub server, the ISO fallback). Changed only as the plan's exact list says: sandboxes or pins that gain the owner (`launch-isolation-override-ui`, `landing-unreachable-state`, `error-string-parity`, `account-self-service-ui`, `orphan-hooks-banner`, `stranded-wraps-ui`), and bridge tests that expect the text fields with a pinned zone (`operator-bridge-panel`, `api-bridge-gateway`, `api-bridge`). `import-banner-buttons` and `port-owner-kind-panel` pass unchanged.
## 2026-10-16 — #2299, #2384 (refs): a `tc` command reference, and the sixteen auto-stubbed FEATURES.md files described

<!-- prawduct: type=docs | scope=w3-a2-tc-reference-and-features-stubs-2299-2384 -->

v5.34.0 Wave 3 chunk W3-A2, records / public docs. Branch `docs/w3a2-tc-reference-features-stubs`. Refs #2299, #2384 (`Fixes` only if the Integrator agrees). Plan: `.tangleclaw/plans/w3-a2-tc-reference-and-features-stubs-2299-2384.md`. `FEATURES.md` is edited under the narrow exception to rule #262 cl.3 (charter v2.3 §3, A106 item 4, Architect A107): the stub block and the sections its descriptions land in, nothing else. `CHANGELOG.md` is not touched; its line and this page's Features line are in the PR body.

**Why.** #2299: `tc` had no single page; a reader rebuilt it from `tc --help` and from chapters about single features, and nothing failed when the roster moved. #2384: the wrap's `## TODO (auto-stubbed 2026-10-11)` block held sixteen undescribed files, and `test/features-index.test.js` turns `main` red on it from 2026-10-25 00:00 local.

**What changed.** `docs/tc-cli-reference.md` (new) is #2299's draft (from `8cbaf34b`) re-checked against `bin/tc --help` and `lib/tc-verbs.js` on this head. It gains what the draft lacked: `tc queue`, `tc check`, the `tc docs` `base`, `attest`, notice and `--group` forms, and exit 2 when the shell's launch identity differs from the pane's. It avoids a verb count and names no machine, path, hosted link or session. `docs/user-guide.md` gets a short "The `tc` command" section under Sessions that links it. `test/tc-cli-reference.test.js` (new) reads the verbs from `tc --help`, run with an empty environment, and fails when one has no table row, when a row names a verb `tc` does not have, or when the help parse misses a roster verb. In `FEATURES.md`, fourteen files are described in Tests, CLI / Tooling and Governance / Engines. `lib/bridge-helper/bridge-client.js` is removed because the Discord helper entry already names it, and `docs/releases/v5.32-status.md` because it is a per-release status record, not a feature. The block's heading goes with it.

**Proved once, not committed.** With every `tc queue` row deleted from the page, the new test fails naming `tc queue`; the page was restored byte for byte. By script on the page: every relative link and anchor resolves, every table row has its header's column count, every flag is in the code, and every subcommand is in that verb's `tc --help` usage. The link check covers relative links only; it reports and skips the user guide's one external link.

**Architect pre-suite review (A112).** The user guide said `tc` works only in a launched session, but `tc --help` answers before reading any environment (exit 0 with an empty one; `tc` with no verb exits 1 with the roster; `tc whoami` exits 1). The guide and the page's "Fast help" now say the verbs need a launched session and `tc --help` works anywhere.

**Review.** Critic (cumulative, inferred by the coordinator, one reviewer over `32a25c9d`): 0 blocking, 2 warnings, 2 notes. The page's sentence on which verbs are left out of the primed list now says `candidate` is primed once the operator tells every session about candidates (R-4).

**rev-20261016T184951Z-5afddbf0** — 2026-10-16T18:51:16Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | The full suite runs once on the final tree in the queue's suite slot (rule #262 cl.4) and is recorded then. Narrow on the working tree: test/tc-cli-reference.test.js and test/features-index.test.js, 27/27. |
| R-2 | warning | fixed-unreviewed | fixed in `.prawduct/change-log.md` |
| R-3 | note | accepted | Deliberate (plan deliverable 1, #2299's Expected): the page ships in 5.34.0 and says tc --help is the authority on any other install. |
| R-4 | note | fixed-unreviewed | fixed in `docs/tc-cli-reference.md` |

**4 findings** (2 warning, 2 note) — accepted: 2, fixed-unreviewed: 2.

**Architect re-review (A113).** The bridge preamble was still too strong: `--request-id` is optional on every bridge write but `circuit ack`, and `tc` generates one when it is left out. The preamble now says so. It tells a caller who may need to retry to give its own `--request-id` and reuse it, and keeps the `--version` requirement on route and candidate decisions as a separate sentence.

**Second review.** Critic (cumulative, over `401b3c01`): 0 blocking, 0 warnings, 1 note. The page's bridge preamble now says every bridge write except `circuit ack` takes `--request-id`, as `tc --help` does.

**rev-20261016T185620Z-8f95fa3b** — 2026-10-16T18:57:05Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | note | fixed-unreviewed | fixed in `docs/tc-cli-reference.md` |

**1 finding** (1 note) — fixed-unreviewed: 1.

**Third review.** Critic (cumulative, `rev-20261016T190012Z-11df5057`, over `2ce595f9`): no findings.

**Observer source check (head `4ebe2810`).** Accepted, with one correction to the evidence. The stated reason for removing the `v5.32-status.md` stub claimed that the other release status files have no FEATURES.md entry, but `v5.30-status.md` has one ("v5.30 release manifest", #2020). The reason above now says only that `v5.32-status.md` is a per-release status record, not a feature. The removal itself is unchanged. The commit message of `32a25c9d` keeps the old wording as history. The full suite started on `4ebe2810` was stopped on the Integrator's instruction and is not evidence for merge.

## 2026-10-16 — #2175, #2349 (refs): one clock for the two-clone summary comparison, and the guard sees a returned git wrapper

<!-- prawduct: type=chore | scope=w3-a1-test-determinism-2175-2349 -->

v5.34.0 Wave 3 chunk W3-A1, test-only. Branch `fix/2175-2349-test-determinism`. Fixes #2175; Refs #2349, whose direct-wrapper survivor the Integrator logged on the issue for follow-up (the PM's ruling: the narrow shape, inside the row). Plan: `.tangleclaw/plans/w3-a1-test-determinism-2175-2349.md`.

**Why.** #2175: `test/checkout-freshness.test.js`'s two-clone case compared `ca.summary`, rendered inside `projectCheckout`, with `cf.describe(ca)`, rendered later. Both say the observation's age through `lib/checkout-summary.js`'s `_internal.now`, which read the real clock, so a second boundary between the two renders changed "observed Ns ago" and failed the `deepEqual`. #2349: the #831 guard in `test/temp-repo.test.js` stayed green over a wrapper returned by a call and called at once, `at(dir)('init', …)`, because its wrapper shape keys on the name `git`.

**What changed.** No production code. The two-clone case installs a clock that freezes on its first read (the first render, after the observation), so both renders read one instant, and asserts the age the pinned clock gives. The guard's `SHAPES` gains `)( 'init' | 'clone' …`, with a comment naming what a line scanner still cannot see: a wrapper with another name called directly (`run('init')` in `test/cache-bump-guard.test.js`, left for #2349) and a subcommand held in a variable. The scanner fixture adds the issue's two lines and two clean `at(dir)(…)` neighbours, and is checked line by line against the expected matches instead of a copied count.

**Proved once, not committed.** With the real clock advanced 1 s between the renders, the fixed case passes and `origin/main`'s fails on "the chip and the prime read one wording". On a clean extract of `origin/main`'s `test/` with the issue's lines added, `main`'s guard passes (the issue reproduced) and the fixed guard fails, naming both lines; with the lines removed it passes. The sanctioned counts (2 and 1) are unchanged.

**Review.** Critic (verify-resolutions, the mode the coordinator inferred, one pass over `e3236ad7`): 0 findings, 2 observations.

**rev-20261016T181447Z-2ea085de** — 2026-10-16T18:16:08Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | accepted | The full suite runs once on the final tree in the queue's suite slot (rule #262 cl.4), after the change-log entry and before the draft PR. Both edited files already pass narrow: checkout-freshness 18/18, temp-repo 10/10. |
| O-2 | accepted | Added in the next commit, before the suite (charter 1.5 freeze order: Critic, then change-log, then suite). |

**No findings** — a clean pass.
**2 observations demoted** — 2 answered. An observation gates nothing; answering one is optional.

## 2026-10-15 — #2358 (refs): a measured Antigravity pane holding a stranded nudge, pinned test-only

<!-- prawduct: type=chore | scope=w2-a2-listener-reconnect-and-wrapped-nudge-2370-2358 -->

v5.34.0 Wave 2 chunk W2-A2 part A2b, test-only (Architect A100 `a2b a test-only`, A101 `a2b 1`). Branch `fix/2358-a2b-wrapped-nudge`. Refs #2358, which stays OPEN after this merges, deferred to the next batch (the PM's ruling `2358 stays open`). Part A2a (#2370) is deferred out of this batch (the PM's `2370 defer`). Plan: `.tangleclaw/plans/w2-a2-listener-reconnect-and-wrapped-nudge-2370-2358.md`, section "M1 recorded".

**Why.** #2358 says a stranded nudge is not recognised when a wrap starts a continuation row with Antigravity's glyph `>`, and was reproduced only on a constructed frame cut at a fixed column. A read-only capture of a live Antigravity pane (agy 1.3.6, 179x44, text width 177, 2026-10-15 23:01:28 PDT; every row above the composer redacted; sha256 `4fb32949…cd0ec`) held the monitor's own nudge. The engine had wrapped it at word boundaries (rows of 168, 175, 174 and 54 text characters, each break where the next word would not fit). Every `>` in the nudge is inside a word starting `<` or `"`, so this ONE configuration did not reproduce the condition. A pane narrower than such a word hard-breaking it at a `>` is unmeasured and stays unresolved.

**What changed.** No production code. `test/fixtures/antigravity-composer-m1-stranded-nudge.txt` (new) is the redacted capture, byte for byte. `test/medusa-wake.test.js` adds a block that feeds it the way the monitor reads a pane: (a) the composer reading recognises all four wrapped rows (`locateComposer`, `readComposerDraft` complete to the lower border, the text compared whole with what the fixture's rows give) and `isOwnNudge` accepts it; (b) the production pane gate, with no `engineIdle` (the live Antigravity path has no engine channel), refuses it as `not-at-rest`, because the profile's idle marker `? for shortcuts` is on no row of the capture. (b) is a characterization of current conservative behaviour and an investigation lead, not desired behaviour and not evidence the engine was working. It does not establish why the marker is absent, nor what any earlier live tick saw. A diagnostic case shows `engineIdle` true reading `at-prompt`, to explain the gate difference only. The synthetic hard-cut test is unchanged. After a dedupe, the PM put the idle-marker lead on #2358 as a comment rather than a new issue.

**Review.** Critic (cumulative, one pass): 0 blocking.

**rev-20261016T061159Z-e330e030** — 2026-10-16T06:12:32Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | The suite runs once on the final tree in the Integrator's slot (rule #262 cl.4), before the PR. The narrow ring already covers the new cases: node --test test/medusa-wake*.test.js gave 940/940, the four new cases included. |
| R-2 | note | accepted | Tracked: after a dedupe of 388 open issues (charter 1.3(h)), the PM ruled '2358 stays open' (d52a374e, queue log 23:10). The idle-marker lead goes onto #2358 as a comment, and #2358 stays OPEN, deferred to the next batch. The PR is Refs #2358 only. |

**2 findings** (1 warning, 1 note) — accepted: 2.

## 2026-10-15 — #2393: turning a launch-isolation override on asks first, and the dashboard says while one is on

<!-- prawduct: type=feature | scope=w2b2-host-check-direct-trust-and-override-indicator -->

v5.34.0 Wave 2 chunk W2-B2 chunk 02 of 2. Branch `feat/w2b2b-isolation-override-indicator`. Refs #2393 (the PM decides `Fixes` or `Refs`). Plan: `.tangleclaw/plans/build-plan-w2b2-host-check-direct-trust-and-override-indicator.md` (chunk 02 accepted by the Architect's A78; released by TC-Lane-INT).

**Why.** An override lets a launch that cannot be shown isolated start anyway. It was turned on with one click in a Settings modal, and nothing outside that modal said it was on, so it could stay on unnoticed. #2393's other two candidates (a bound session learning that an override is on; automatic expiry) are not built here: the PM ruled they are filed as their own issues.

**What changed.** `public/ui.js`: `wireIsolationOverride` asks with a native `confirm()` before turning either override on. The question names the scope (the project by name, or every project and the Project Master) and carries the shared risk sentence. Cancel puts the switch back and sends nothing. Turning one off asks nothing. After every write, refused and unanswered ones included, the dashboard notice is re-read after the switch's own re-read, so it is never older than the switch beside it. It is re-read even when Settings has moved to another project. `public/landing.js`: `refreshIsolationOverrideBanner` reads `GET /api/launch/isolation-overrides` at load and after each change. Each read is numbered and only the latest paints, so a late older answer cannot overwrite a newer one, or put back names after a refusal. Each read also gets its own `api()` from the page's factory (same dashboard marker, sign-in and CSRF handling), so its failure is its own: the page's shared `api.lastError` / `lastErrorCode`, which every other request writes or clears, is never read, and an unrelated request finishing at the same moment cannot turn a refusal into a failure or hide a failure behind another refusal. `renderIsolationOverrideBanner` lists the install-wide override and each project with an override on, one row each. Each row's button opens that project's Settings at its switch (`openIsolationOverrideSettings`), or Global Settings at the install-wide switch. Names are text nodes. A project the install no longer has is named by its id, with no button. A refused read (`OPERATOR_ONLY`) hides the notice and takes down any names. Any other failure, or an answer without the settings, says the overrides could not be read, in the info tone. `public/index.html`: the slot, `role="status"`, beside the other main-view banners. `public/style.css`: one row per override, wrapping, with 44px buttons. `docs/user-guide.md` (added to the chunk by the Integrator's file-scope ruling, that one paragraph only): the override bullet under Session Won't Launch says turning one on asks first and describes the notice.

**Tests.** New `test/isolation-override-banner.test.js` runs the shipped functions: what the notice says (none, install-wide, projects, both, a name with markup set as text, a project with no name, a row not on); refused, failed, answered-without-settings, and recovery from each; the race in three orders (older last over a newer none, older last over a newer refusal, newer last); each button's target and label; switches and notice run together (on puts it up, off takes it down, Cancel sends no request at all); the slot, the load-time read, and the read route only. `test/launch-isolation-override-ui.test.js`: the sandbox's `confirm()` now answers yes by default, so the existing cases test a confirmed change, and new cases cover asking on ON in both scopes, Cancel, no question on OFF, and the notice re-read after success, refusal and no answer, and after Settings moved on. The routes test now allows `landing.js`, which may name only the one read call. Three concurrency cases run the real `public/api-helper.js` with the notice's read and an unrelated page request answered together: a refusal still hides when the unrelated request fails or succeeds, and a genuine failure still shows when another read is refused; all three fail against the shared-slot read. Eight mutations, each caught: the read number, the question, Cancel leaving the switch on, the notice re-read, a parallel re-read, a failure that hides, a name through `innerHTML`, and a refusal leaving names up. `test/version-visibility.test.js` pins `loadServerInfo()` as the last load-time read, so the new read sits earlier in that list.
## 2026-10-15 — #2389 (refs): shared-doc notices are delivered by the rule, with mute and subscribe

<!-- prawduct: type=feature | scope=w2-a1-shared-doc-notices-2389 -->

v5.34.0 Wave 2 chunk W2-A1 part A1b, the second of two. Branch `feat/2389-a1b-notice-routing`. References #2389; whether this closes it rests on the D4 proof, which is the PM's call. Governance class: notification and wake routing. The design is plan rev 3 (`a4c6b94f…`) with A81 points 4-6, and the order of delivery against the record is the Architect's A89 on the delivery-order note (`81bc22db…`). Schema v68, allocated by the PM. `test/api-shareddocs.test.js` was added to the file list by the Integrator (`a1b api-shareddocs ok`), for its #998 block only.

**Why.** Every shared-doc change woke every member session, whoever's row it touched. A1a recorded which rows changed and who attested the change, and A1b now delivers on that record.

**What changed.** `lib/shared-docs.js`: R1-R4 replace the broadcast. The attested author is never told (R1). The owners of the rows an attested author changed are told (R2). A member that subscribed is told of every `row` or `unknown` revision, an unattested echo of its own write included (R3). Nobody else is told, with no fallback (R4). The revision is recorded first, and in the same transaction its recipients are resolved and persisted as intents, one per (project, live session); an attestation's author binding commits with them. Attest validation runs before the write, so a refused attestation's new bytes are recorded `unknown` and routed to subscribers only. A later resolution of the same revision skips every project already resolved, whatever its outcome. Each call sends only the intents it inserted, outside the doc's queue. Before each send the intent is rechecked: `withdrawn` if the project left the group, stopped subscribing, or the doc was re-registered; `muted` if muted since. Then `offline`, `coalesced` (per reader and doc, `system` sender only, as before), `sent` or `failed`. `done` is reached only when no intent of the revision is pending. `#998`'s containment-owner exclusion is retired (A89 item 3). `lib/store.js`: v68 `shared_doc_notice_prefs` (one scope per row, cascading from project, group and doc; leaving a group drops its settings) and `shared_doc_deliveries` (unique per revision, project and session, with session 0 for a whole-project `muted`/`offline` row; cascading from the revision), with a postcondition; the boot sweep marks a `pending` delivery `interrupted` and its intents `unknown`, never resent or extended, not even by a later first attestation. The sweep runs at boot before the server is built, before any listener or watcher exists; a failed sweep refuses the start (exit 1) and closes routing in the process (Architect A90 H1). `server.js`: the broadcast is removed; the watcher observes and delivers; notify of unchanged bytes notifies nobody, and answers `success`/`notifiedCount`/`coalescedCount`/`errors` for this call's sends plus `seq` and `duplicate` (an unrecorded revision answers 200 with zero counts and an `errors` entry, and sends nothing); `GET`/`POST /api/shared-docs/:id/notices` and `/api/groups/:id/notices` (own setting only, or the operator's for any member; any member reads all); the events route carries each revision's outcomes counted per outcome. `lib/tc-verbs.js`: `tc docs` shows the pane's setting per doc; `tc docs mute|unmute|subscribe|default <doc>` or `--group <group>`. Docs: `data/shared-docs-guide.md` (and the generated `CLAUDE.md` block), `docs/medusa-delivery.md`. No delivery count or shadow selection is a measured wake reduction; the live count is owed after the deploy.

**Tests.** `test/shared-docs-notice-routing.test.js` (new): the plan's A1b criteria 1-9, A89's requirements with a deferred Bridge (overlapping observation and attestation, two batches of one revision, a failed first outcome never re-resolved, a refused attest routed to subscribers only, dispatch-time mute, removal and doc deletion, the interrupted sweep), the preference routes with bound callers and their refusals, `tc docs`, and direct, blocking, reply and HOLD/STOP paths reaching a muted session through the real tracked-send path. `test/store-shared-doc-prefs-migration.test.js` (new). The two `shared-doc-broadcast-*` tests and the #998 block of `test/api-shareddocs.test.js` are REPLACED with the new contract, not weakened: group scope, coalescing and the payload hold as before, and owner exclusion is now R1 plus explicit-subscription cases. `test/launch-binding-routes.test.js` pins both notice routes as guarded; `test/tc-verbs.test.js` the listing.

**Learning (owed from A1a's merge, placed here and in the PR body by the Integrator's ruling).** GitHub's closing keywords are a substring match: "It does not close #2389" closed #2389. Never write `close|fix|resolve` (or their -s/-d forms) followed by an issue reference in a PR body unless closing is meant; GitHub also closes on a colon after the keyword and on a cross-repo `owner/repo#N`. Write "Refs #N", and grep the body with `grep -niE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+([[:alnum:]_.-]+/[[:alnum:]_.-]+)?#[0-9]+'` before `gh pr create`.

## 2026-10-15 — #2414: the host check reads a direct-mode install's served certificate, and says whether its own Node process trusts the local root

<!-- prawduct: type=bugfix | scope=w2b2-host-check-direct-trust-and-override-indicator -->

v5.34.0 Wave 2 chunk W2-B2 chunk 01 of 2. Branch `fix/w2b2a-host-check-direct-trust`. Fixes #2414. Plan: `.tangleclaw/plans/build-plan-w2b2-host-check-direct-trust-and-override-indicator.md` (revision 2, accepted by the Architect's A85, whose clarifications override the plan where they differ; released by TC-Lane-INT).

**Why.** On a direct-mode HTTPS install there is no Caddyfile, and the check read certificates only through Caddyfile sites, so its certificate, coverage and trust rows said nothing about the certificate the server is configured to serve. A routes row reading `tls-unverified` there could not be followed up from the check's own output. The comment beside the loopback request also read as if the only failure were a name mismatch for `127.0.0.1`.

**What changed.** `lib/host-check.js`: in direct mode over HTTPS (and only then), row 4 reads the configured `httpsCertPath` through the same size-capped read, labelled `served certificate (configured)`; a missing, too-large, non-file or non-certificate file is `unknown` with its code. Coverage says whether it carries `127.0.0.1` and each configured name. Trust covers it with the existing issued-by-root check and adds one fact, `local root in this check's Node default CA set`: `yes`, `no` (only when every entry of a valid set was inspected), or `unknown (<code>)` (not measurable on this Node, read failed, too many, invalid shape, or incomplete with the parse count). The set comes from an injected, feature-detected `tls.getCACertificates('default')`; the fact never changes the row's state. The routes reason is unchanged; a `possible cause (not confirmed)` fact naming the configured certificate is added only when TLS failed, the local root issued that certificate, and the root measured `no`. The loopback comment is neutral about the cause. The module header lists the files read and the runtime CA-set retrieval. Caddy mode, plain HTTP and an unsupported ingress mode read nothing new. `docs/host-migration.md`: the paragraph that said the check cannot see a direct-mode certificate, and the sentence under the change table that said these rows never trigger a change on a direct-mode install (now true only over plain HTTP); the second is beyond the plan's one-paragraph scope, found by the cumulative review and flagged in the PR body.

**Tests.** `test/host-check.test.js`: a new describe (direct reads and labels; caddy-mode rows identical with HTTPS fields set; plain HTTP and an unsupported mode read nothing new; missing, too-large, garbage, directory and permission-denied served certificates; coverage of `127.0.0.1` and configured names; ten CA-set cases; the hint with all three conditions and its absence when any one is missing; redaction; a read spy showing no file read beyond the caddy-mode set plus `httpsCertPath`, and no key; a direct-mode install with a leftover Caddyfile, where the served file is a site's own, a different one, or one the root did not issue, which must give no hint; the three allowed commands in direct mode). The existing tests pass unedited. Against the base code 21 of the new cases fail; the rest are guards that pass there by design. (That count is from the first round only.)

**Evidence.** Step 0 (not network-isolated, labelled with its endpoints and process scope): `.prawduct/lane-evidence/w2b2/step0-before.txt` and `step0-after.txt` (git-ignored).

## 2026-10-15 — #2389 (refs): an exact record of every shared-doc revision, with attested authorship; delivery unchanged

<!-- prawduct: type=feature | scope=w2-a1-shared-doc-notices-2389 -->

v5.34.0 Wave 2 chunk W2-A1 part A1a, the first of two (A1b, row-aware delivery with mute and subscribe, is not released). Branch `feat/2389-shared-doc-event-record`. References #2389 without closing it. Governance class: notification and wake routing; the design is the Architect's A79 to A81 (plan rev 3 `a4c6b94f…`), and the code is read by the Architect at its exact head before the suite. Schema v67, allocated by the PM.

**Why.** A shared-doc change wakes every member session, whoever's row it touched, and nothing records which rows changed or who changed them. Row-aware delivery needs both, and needs them recorded exactly before any notice is withheld on their strength.

**What changed.** `lib/shared-docs.js` (new): each distinct digest observed of a doc is one revision, classified against a persisted baseline as `row` (every changed member project, by id), `unknown`, `formatting` or `first-seen`; the watcher, notify, a base capture and an attestation observe through one serializer per doc. Over the 8 MB baseline cap, or compared with such a baseline, a revision is digest-only: `unknown`, `attribution: incomplete`, no rows claimed. `lib/store.js`: v67 `shared_doc_events` and `shared_doc_baselines`, both cascading from the doc, with a postcondition; seqs are never reused. `server.js`: `POST /api/shared-docs/:id/attest` (`{"base": true}` captures a base; `{baseSha256, sha256}` attests; project callers only, 1 KB cap) re-reads the registration, access and the lock after its file read (a doc re-pointed or unregistered meanwhile records nothing, `DOC_CHANGED`; a base capture is re-authorized the same way) and binds the session and project in one statement; notify records without delaying its notice; `GET /api/shared-docs/:id/events` with `latest`, `oldestRetainedSeq` and `gap`. `lib/tc-verbs.js`: `tc docs base` and `tc docs attest` (no fetched base, no retry). Each revision carries a SHADOW `shadowWouldSelect`; the broadcast is untouched and sends what it always sent. Labelled ATTESTED authorship throughout: lock-holder attestation in a cooperative-writer model, not proof of who wrote the bytes. Docs: `data/shared-docs-guide.md`, `docs/medusa-delivery.md`.

**Tests.** `test/shared-docs-events.test.js` (classification, the shadow rule, restart baseline, the cap both ways, serialized concurrent observations, retention), `test/shared-docs-attest-route.test.js` (the plan's A1a criteria through the route with bound callers, every refusal leaving the binding unchanged, the stated unobserved-overwrite limit, the events route, and the CLI), `test/store-shared-doc-events-migration.test.js`; one case each added to the two broadcast tests (payload byte-identical; a failed record never stops a notice) and one to `test/launch-binding-routes.test.js`.

## 2026-10-15 — #2361 and #2366: Project Settings fits a phone; the wrap drawer says who merges a coordinated wrap PR

<!-- prawduct: type=bugfix | scope=w2b1-settings-narrow-and-wrap-drawer-merge-authority -->

v5.34.0 Wave 2 chunk W2-B1, its one chunk. Branch `fix/w2b1-settings-narrow-wrap-drawer`. Closes #2361 and #2366. Plan: `.tangleclaw/plans/build-plan-w2b1-settings-narrow-and-wrap-drawer-merge-authority.md` (approved by TC-Lane-INT; the PM's `b2 w2 files ok`; `test/settings-hint-wrapping.test.js` added for one assertion by the Integrator's `w2b1 add hint test`; two #2320 tests' row assertions and one `docs/user-guide.md` sentence added by its `w2b1 files ok`).

**Why.** (#2361) At a 320 px viewport Project Settings scrolled sideways: the toggles grid's track minimum was a bare `290px`, a grid track never shrinks below its minimum, and the modal body there is narrower (measured 39 px past the edge, the Silent prime cell). (#2366) A wrap PR left unarmed because a coordinator merges it read on the commit row as a failure to arm, and its sentence sat under "How to fix this" although nothing needs fixing; meanwhile every other close-loop remediation (a failed push or PR create, a hold, the methodology withhold), written under `autoPr`, was never shown at all.

**What changed.** `public/style.css`: the three settings grids' track minimums become `min(<n>px, 100%)`, with the reason beside them; the `.form-hint` comment follows. `public/wrap-drawer.js`: the commit row names who merges first, as the priming row does since the row is cut to one line (`<coordinator> merges this wrap PR; auto-merge not armed`, or `who merges this wrap PR is unknown: <reason>`; the Integrator's `name first`), and shows no fix heading for that case (`stepRemediation`, `mergeAuthorityPhrase`); otherwise a commit row with no remediation of its own shows `autoPr.remediation`; the `pr-merge` and `priming-roll` tooltips name the coordinated project. The skipped `pr-merge` row already printed its reason through the shared skip path; a test now pins it. `lib/` is unchanged: the commit step still repeats the sentence as its own remediation, and the drawer ignores it for that case. `docs/user-guide.md`: the one sentence that gave the old row text.

**Tests.** `test/wrap-drawer.test.js` (a new describe, fixtures shaped as `lib/wrap-steps/commit.js` returns them, sentences from `lib/merge-authority.js`'s own `describe`); the new `test/settings-narrow-overflow.test.js` (each grid's block scoped, the capped floor present and no bare pixel minimum left); the hint test's geometry pin moved to the new floor, its gap and ceiling pins unchanged; the #2320 row assertions in `test/wrap-step-commit-autopr.test.js` and `test/wrap-pipeline-lane.test.js` now pin the name-first row text and no remediation (the Integrator's `w2b1 files ok`), every step-result assertion untouched. Run against the base code, the new cases fail (9 drawer, 6 grid).

**Browser.** An automated run under the Browser slot, not yet seen by the Operator: before and after at 320 and 375 (frames, overlay and forced 8 px scrollbars), desktop two-up with a saved toggle surviving a reload, the drawer from fixtures at 900, 375 and 320. Record: `.prawduct/lane-evidence/w2b1/browser/browser-check.md` (git-ignored). Limit seen: the drawer's one-line row detail (`public/session.css`) cuts the new sentence on screen; the banner carries it whole once the PR status reads pending.

## 2026-10-15 — #2364: the Operator settles a merge queue entry stuck in landing

<!-- prawduct: type=feature | scope=w1-a2-merge-queue-2372-2364 -->

v5.34.0 Wave 1 chunk W1-A2 part A2b, the second of two (A2a, #2372, merged as `55ed0669`). Branch `fix/2364-settle-stuck-landing`. Closes #2364. Governance class: the design is the Architect's A60, A72 and A73, and the code is accepted by the Architect at its exact head before the merge.

**Why.** A merged pull request that GitHub will not name a landing for (no merge commit, or one that is not a merge of the submitted head) left its entry `landing` for good, and nothing behind it advanced. No route moved it; it needed a change to the records by hand.

**What changed.** `POST /api/merge-queue/entries/:id/settle-landing`, the Operator's alone (`OPERATOR_ONLY` for any project, the owner included), with a reference and an attestation, for an entry in `landing` only. It holds the queue's slot as an advance and a withdrawal do, reads the entry again inside it, and the store checks `landing` in the write, so of two settlements one is recorded. `landed` names a commit: it is read (`SETTLE_COMMIT_UNREADABLE`), the base tip is read now, and the commit must be reachable from it (`readAncestry` in `lib/merge-queue-github.js`, the compare call `readCompareFiles` already makes; `SETTLE_NOT_ON_BASE` otherwise). The tip never stands in for the commit; the tree decides a `TREE_MISMATCH` halt. `failed` is the Operator's disposition: the pull request is read now, and the queue halts `LANDING_SETTLED_UNRECONCILED` unless it reads back unmerged AND the Operator sends `mergeAttempt: 'unsuccessful'`; the answer calls an unmerged read a snapshot, never proof. Every GitHub read is required and an unreadable one refuses `503` with nothing changed. An existing halt is kept, code and detail; a settlement that would itself halt records its reason as a further `queue-halted` event, one that would not adds none, and `settlement.haltReasonRecorded` says which. `recordLanded`'s own tree-mismatch halt now keeps an existing halt the same way. The candidate's branches are removed only after the write, only the entry's recorded `tc-queue/` branch, never a name made from its id or one another unfinished entry records; a skip is reported, a failed removal is retried by the next advance under the same checks (`cleanupRefFor`, `cleanupFinished` in `lib/merge-queue.js`, which now also owes cleanup for a settled failure). `docs/merge-queue.md`: the route, a "Settling a stuck landing" section, the refusals, `readAncestry`, and the Limits updated. No schema: the codes live in existing free-text columns and event details.

**Tests.** `test/merge-queue-api.test.js` (12 cases, through the route with bound callers): both of the issue's reproductions, every refusal and unreadable read with nothing changed, callers and bodies refused before any read, a repeated settlement, a settlement refused while the slot is held, two at once, an entry leaving `landing` mid-read, halts kept, the three `failed` cases, and cleanup skipped, failed and retried. `test/merge-queue-store.test.js` (11), `test/merge-queue-advance.test.js` (6: no advance reaches `failed` from `landing`; the retry's ownership checks), `test/merge-queue-github.test.js` (6 plus `readAncestry` in the failed-read loop, replaying the recorded comparisons), `test/launch-binding-routes.test.js` (the route is guarded). Run against `origin/main`'s code, all 37 new or changed cases fail.

## 2026-10-15 — #2371 (refs): the CI-as-suite governance packet, for the Architect's acceptance; nothing put in force

<!-- prawduct: type=docs | scope=w1b2-ci-as-suite-activation -->

v5.34.0 Wave 1, chunk W1-B2, its one chunk (doc-only, as the Architect's A61 scoped it). Branch `docs/w1b2-ci-as-suite-packet`. References #2371 without closing it: the packet is not activation.

**Why.** #2321 built the evidence tooling; what #2371 still needs is not code here but three decisions outside this repository: Prawduct accepting CI evidence, the Operator activating a lane rule, and one measured chunk. A61 asked for the packet those decisions are made on, with the Prawduct claim traced rather than searched for. The trace of the installed 3.6.1 shows every gate that reads suite evidence reads only `.prawduct/.test-evidence.json` and the store's `test-run` facts, written only by `test-evidence record`, whose `--from-junit` stamps the local tree whatever the report's origin. So a rule cannot come first.

**What changed.** The packet itself is a lane plan, `.tangleclaw/plans/w1b2-ci-as-suite-packet.md`, untracked and served at its plan link: the trace (readers, the one writer, line references, the executable's digest); the upstream report's bytes by digest; the replacement Builder (#262/#264, clause 4) and Integrator (#266, clauses 1 and 2(d)) texts, each made by replacing only the named sentences, with full texts and digests; the measurement protocol with the measured Wave 1 suite times; the live tooling check, two parts done and two owed. `docs/prawduct-feedback.md`: the upstream draft rewritten as one fenced block (the only bytes that would be sent; scrubbed of paths, hosts, accounts, numbers of this install), with the 3.6.1 trace, `ci_evidence_command:` as the preferred ask, and baseline, measured and target figures kept apart (measured: runs started 15:00 to 16:50 PDT on 2026-10-15, four completed and one killed, with each run's receipts in the notes outside the block); still NOT SENT. `docs/lane-ci-evidence.md`: the opening and the "changes nothing a gate accepts" paragraph state the trace; the proposed section gives the activation order (Prawduct, then the rule bound to this page's accepted revision by digest, then the complement verified before first use, then exactly one pilot chunk named at plan approval, which needs the charter's pre-suite order amended by name, then broader use decided separately from the pilot's time and safety results), makes Prawduct's acceptance the rule's first condition, requires the reviewer to read the workflow at the exact commit, bans recording CI's result by hand, keeps the nine exceptions, names the four rule sentences it would change, and records that a lane host can skip tests CI runs (`test/engine-temp-root.test.js` on a host whose `/tmp` is not sticky); still NOT IN FORCE.

**Tests.** No code changed. `test/ci-evidence.test.js`'s four document assertions (the NOT IN FORCE heading, the opening, the nine exceptions, NOT SENT) pass on the edited files.

## 2026-10-15 — #2372: the merge queue will not land while its owner has an unhandled message

<!-- prawduct: type=feature | scope=w1-a2-merge-queue-2372-2364 -->

v5.34.0 Wave 1 chunk W1-A2 part A2a, the first of two (A2b, #2364, stays design-held). Branch `fix/2372-merge-queue-unread-guard`. Closes #2372. Governance class: the design is the Architect's A60, and the code is accepted by the Architect at its exact head before the merge.

**Why.** On 2026-10-12 a pull request was merged while its authorizer had an unread message objecting to it. Nothing in the queue looked at the owner's inbox, so an approval nobody had read could be acted on and an objection nobody had read could be passed over.

**What changed.** `lib/merge-queue.js`: a landing reads the owner's inbox last, then asks the caller's guard, then records `landing-started` and sends the merge request, with nothing awaited between them. Any message still unhandled refuses it `AUTHORIZER_MESSAGE_UNREAD`, naming each by id and sender and never its text; an inbox that cannot be read refuses it `AUTHORIZER_INBOX_UNREADABLE`; an advance given no inbox check lands nothing. Either refusal changes nothing: the entry stays `testing` with its candidate. Assembly, discards, failures and branch cleanup read no inbox. `lib/merge-queue-api.js`: the inbox is that of the session behind the launch the request was verified as, never one the request names; the binding is resolved again at the read, so a launch that has ended or been replaced cannot land, and a listener that is not listening reads as unreadable, never as empty. A message whose envelope `from` is `system` is counted and does not block; the body is never judged. `lib/merge-queue-store.js`: `landing-started` records the head, base and candidate, and the check's binding (project, launch, session), time, listener state and count of system notices left out, keeping only those fields; a malformed check is refused. `docs/merge-queue.md`: the landing table, a paragraph on the inbox, two refusals, and three limits (a hand merge is not guarded; the check is a snapshot that misses mail in transit; a process reaching the Bridge directly can pass as `system`). An owner project without the switchboard can no longer land through the queue.

**Tests.** `test/merge-queue-advance.test.js` (8 cases): unreadable, absent and empty checks, an unhandled message, the record after handling, the order inbox, guard, merge request, a guard refusing after a clear inbox, and the steps that merge nothing. `test/merge-queue-api.test.js` (9 cases, through the route with bound callers): no listener, a listener not listening, the bound session's inbox only, an unread approval, an objection arriving mid-landing, a system notice against a peer posing as one, landing after handling, assembly unaffected, and a launch ended and replaced mid-landing. `test/merge-queue-store.test.js` (3 cases): the record, field stripping, malformed checks. The existing API advance tests' shared setup now gives the owner a listening, empty inbox; no existing assertion changed. Run against `origin/main`'s code, 18 of the 20 new cases fail; the other two check that steps which merge nothing read no inbox, which was already so.

## 2026-10-15 — #2304/#2408 (refs #2412): a checkout fingerprint leaves no git running when its deadline ends, and the wedged-tmux test counts what it started

<!-- prawduct: type=bugfix | scope=w1b1-fingerprint-and-tmux-test-races -->

v5.34.0 Wave 1, chunk W1-B1, its one chunk. Branch `fix/w1b1-fingerprint-orphan-git`. Fixes #2304 and #2408; closes #2045 by reference (already fixed by `c95d855d`, #2061's PR, which never named it); references #2412 without closing it, because its own failed run was not reproduced.

**Why.** `fingerprint()` races each git call against its deadline. When the deadline won, it returned `deadline` at once, and the git it had started kept running in the checkout until `execFile`'s own timeout killed it. Reproduced on demand against `main`'s code with a stand-in git at the `status` call (9 of 9 failed): a hung or SIGTERM-deaf git was still alive when `fingerprint()` returned, and with a git writing inside `.git`, removing the repository at once threw `ENOTEMPTY: directory not empty, rmdir <tmp>/.git/…`, #2304's error. Node's test runner reports an `afterEach` failure as a failure of the test before it, which is how #2304 appeared on the early-timer test; #2412 failed on that same test with its message lost, and is probably the same failure, unproven (that test passed 200 of 200 alone on `main`). In the product the same orphan can leave `git status` holding `index.lock` in a live checkout after a rotation's fingerprint times out. Separately, #2408: the wedged-tmux test counted started commands from the stand-in's own log, which the stand-in wrote only after forking `cat`; killed at 300 ms on a loaded host before that line, it read 0. Reproduced by delaying the stand-in's start by 0.5 s: `main`'s test fails with #2408's exact `0 !== 1`.

**What changed.** `lib/checkout-fingerprint.js`: a git call the deadline ends is aborted; `_runGit` sends SIGTERM (git removes its own lock files on it), then SIGKILL after `KILL_GRACE_MS` (1000 ms), and settles only once the child has exited. `fingerprint()` waits for that, bounded by the grace plus `REAP_MARGIN_MS` (500 ms) so a runner that ignores the abort cannot hold it; a timeout is still told by the `DEADLINE` sentinel, never by the clock. The program run is a seam (`_seams.bin`). No caller changes: they only await the result, which can now come up to 1.5 s after the deadline.

**Tests.** `test/checkout-fingerprint.test.js`: four new cases through the real runner and a stand-in git (hang, deaf to SIGTERM, writing inside `.git`) and a runner that ignores the abort: each ends as `deadline`, with the child gone at return, the repository removable at once without retries, and the return bounded. The stalled runners in the two existing deadline cases now settle on abort, as the real runner does. `test/tmux-read-pane-async.test.js`: the two wedged-read cases count children from the spawn, through the `tmux._async.execFile` seam, not from the stand-in's log; the stand-in logs its pid first. The reads in that file whose assertions are about what is answered, not how fast, now share one generous named timeout (`ANSWER_TIMEOUT`, 60 s): on a run beside a full suite (load 13) two of them hit the 5 s default on the first session probe; the four timeout cases keep their own short bounds. No assertion was weakened.
## 2026-10-15 — #2417, #2365, #2312: the bridge's status pages say what shipped, and three doc pointers are corrected

<!-- prawduct: type=docs | scope=w1-a1-docs-2417-2365-2312 -->

v5.34.0 Wave 1 chunk W1-A1, the only chunk of its plan. Branch `docs/w1a1-bridge-status-pointers`. Closes #2417, #2365 and #2312. The status wording is a public statement, accepted by the Architect (A60 limits, A62 corrections, A63 acceptance) before the suite; the cutover facts are the ProjectManager's.

**Why.** The operator bridge and its Discord helper shipped in v5.31.0, but three pages still said the helper had never run against Discord and that cutover had not started, and no entry page led to the bridge (#2417). `docs/merge-queue.md` listed four of the six codes an entry fails with (#2365). The user guide sent readers to a "pane-check section" of the engine guide that does not exist (#2312).

**What changed.** `docs/operator-bridge-helper.md`, `docs/operator-bridge.md` and `docs/discord-operator-notifications.md`: shipped in v5.31.0 as a fact about the release; off by default; cutover per install; the direct procedure applies only where an existing rule explicitly authorizes it, and a fresh install has none; Rule #188 and #145 dates given only as the project's own install's identifiers; the fresh inbound round trip (#1836) and the live `lane-silent` / `gateway-down` / `gateway-recovered` notifications (#2262, #2272) still unproved. The helper page gains a fresh-install quick start that links its own steps, and its bot-token paragraph tells a fresh install to use `set-secret bot`. `README.md`, `docs/setup-guide.md` and `docs/user-guide.md` each gain a short "Discord operator bridge" section. `docs/merge-queue.md` names `CANDIDATE_CONFLICT` and `NOTHING_TO_MERGE`. The user guide links the engine guide's "The ambient-awareness floor (`tc` on PATH)". `docs/discord-operator-notifications.md` also no longer calls the bridge a "Future path" (heading, one subheading and its closing line, accepted in A64). One wrong cross-reference fixed on the way: the rollback bullet's interim section is above it, not below. The older #2363 entry that #2365 also mentions is left as written.

**Tests.** New `test/docs-w1a1-pointers.test.js`: each entry page has exactly one bridge section linking all three bridge pages; every relative link and anchor in those sections, the helper's status and the user guide's pointer resolves to a file and heading that exist; no bridge page keeps the stale claims or says a direct procedure is in force everywhere; no page says "supported since v5.31"; `docs/merge-queue.md` names every code in `FAILURES`. Run against `origin/main`'s pages, 7 of its 8 cases fail; the eighth is a guard those pages already met.

## 2026-10-15 — #1380/#2142: a public guide to moving TangleClaw to another machine

<!-- prawduct: type=feature | scope=host-migration-guide-1380 -->

#1380/#2142 chunk G, the second of two (H, the host check, merged first). Branch `docs/1380-host-migration-guide`. References #1380 and #2142 without closing either. The contract is chunk G of the host-migration follow-ups packet (TC-Lane-A's plan for #1380, not in the repository), as corrected by the Architect's A11 and accepted in A12; its source is the ProjectManager's reviewed draft guide.

**Why.** A real migration showed that moving an install mixes two layers (a name that resolves, and a name TangleClaw answers to) and two different procedures (a planned move with a fresh identity, and recovery from an accidental clone). Nothing in the repository said how to tell them apart, or how to change only what was diagnosed and undo it exactly.

**What changed.** New `docs/host-migration.md`: the two layers; the two migrations as separate sections (clone recovery never logs out or revokes the source while it shares the identity); a before-the-move checklist with a consistent, verified SQLite backup of the database (`.backup`, `PRAGMA integrity_check`), never a live-file copy; how to run `node scripts/host-check.js [--reveal]`, its row states and exit codes, what it never prints, that it is not network-silent, and why a direct-mode HTTPS install may read `unknown` on its routes row (`lease comparison: tls-unverified` means only that validation failed: diagnose trust, validity and names, and never re-mint on that row alone); then each change (re-trust, mint, serve route, Caddyfile hand edit, the last only with a tested recovery path independent of TangleClaw and a restore plan) with the row that triggers it, the snapshot taken first and the exact state its rollback restores; proof per name from another device; renaming; rollback triggers; today's limits. Placeholders only. One link line each in `docs/recovery.md` and `deploy/INGRESS.md`.

**Tests.** New `test/host-migration-guide.test.js`: a shape-based privacy linter (private, CGNAT and unique-local addresses other than the `100.64.0.10` placeholder; `*.ts.net` and `*.local` names other than all-placeholder ones; absolute home paths; UUID, launch-id and workspace-id shapes), run against synthetic sentinels so a rule that stops matching fails, and against the guide. It also checks the guide's exit codes and row states against `lib/host-check.js`, and that every script it names exists. No deny-list of real values is in the repository; the private scan ran outside it.

## 2026-10-14 — #1380/#2142: the host check prints an error code only when it is on a finite list of known codes

<!-- prawduct: type=bugfix | scope=host-check-error-codes-1380 -->

#1380/#2142, the second redaction follow-up to chunk H, required by the Architect's A23 before H is called share-safe, released or deployed. Branch `fix/1380-host-check-error-code-allowlist`. References #1380 and #2142 without closing either: chunk G remains. Merges only on the Architect's acceptance of its exact head.

**Why.** The entry below kept an error's `code` when it matched `/^E[A-Z0-9_]{1,63}$/`. That is a spelling filter, not a list: a thrower can set any `code`, and a secret spelled like one (`ERR_TOKEN_SECRET123`) passed it into the internal-error reason, the `--reveal` diagnostic, the local-resolution result and the CLI's failure line. Root cause: "shaped like an errno code" was treated as "is a known errno code", and every sentinel the tests seeded was lower case or held a path, so none passed the filter.

**What changed.** `lib/host-check.js` replaces the pattern with `KNOWN_ERROR_CODES`, a finite list of the codes this check's own calls can raise: file reads (`ENOENT`, `EACCES`, `EPERM`, …), `dns.lookup` (`ENOTFOUND`, `ENODATA`, `EAI_AGAIN`, …), the local ports request (`ECONNREFUSED`, `ETIMEDOUT`, …), running a command (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) and Node's argument checks (`ERR_INVALID_ARG_TYPE`, …). Any other code, however it is spelled, gives the same fixed text as no code: `internal-error`, `lookup-failed`, or a diagnostic of the error class alone. The module header, `safeErrorCode`'s JSDoc and the CLI's comment no longer call a shape a closed set. An operator sees no change unless a code outside the list was thrown.

**Tests.** `test/host-check.test.js`: three synthetic secrets spelled exactly like codes (`ERR_TOKEN_SECRET_QX7`, `ESECRETQX7`, `EAI_QX7`) go through every path that prints a code: a thrown row (reason and `--reveal` diagnostic), a lookup failure (default and `--reveal`), the CLI's failure line, and `safeErrorCode` itself, which also now refuses `EFIXTURE`. The CLI's positive case uses `EACCES`, a real code. Run against the module as merged in #2410, the four new or extended cases fail and the rest pass.

## 2026-10-14 — #1380/#2142: the host check prints no raw value from a file or a command, and no error message even under `--reveal`

<!-- prawduct: type=bugfix | scope=host-check-redaction-1380 -->

#1380/#2142, the redaction follow-up to chunk H, required by the Architect's A22 before H is called share-safe, released or deployed. Branch `fix/1380-host-check-redaction`. References #1380 and #2142 without closing either: chunk G remains.

**Why.** The redactor shows a value of kind `code` verbatim, and a row's reason is printed as written. H labelled some values `code` that came straight from a hand-editable file or a command: `config.ingressMode`, the topology marker's version, Tailscale's `BackendState`, and an error's `code`. Those values could carry a name, path or secret past redaction. And `--reveal` printed a thrown error's message and stack frame, which breaks its promise never to show credentials. Root cause: redaction was decided by the field's label, not by where the value came from. H's redaction test seeded sentinels only in the fields H already redacted.

**What changed.** In `lib/host-check.js` every value read from outside reaches a code or a reason only through a closed set:

- `ingressMode`: `direct` or `caddy` (the set `server.js` accepts; absent means `direct`). Anything else prints `unsupported`, and the config row is `unknown: ingressMode-unsupported`. With no Caddyfile, that row reads `unknown: absent; ingressMode unsupported` rather than `observed`.
- The topology marker: only `v1` is kept. Any other version prints `marker of an unsupported version` and is never stored in the parse result.
- `BackendState`: Tailscale's own states map to `daemon-<state>`. Any other value gives `daemon-unrecognized-state`.
- Error codes (`internal-error:<code>`, the local-resolution result, the CLI's top-level failure line in `scripts/host-check.js`): kept only when shaped like a Node or errno code (`safeErrorCode`), else `internal-error` or `lookup-failed`. (Not a closed set: the entry above replaces the shape with a list.)
- The `/api/ports` row's reason for an unexpected HTTP status is `status-<n>` only when the status is an integer, else `status-other`.
- The diagnostic a thrown row keeps for `--reveal` is now its built-in error class and safe code (`TypeError EACCES`; a custom class prints as `Error`; a thrown non-error prints `non-error-value`). It never holds the message or a stack frame.

**Contract change, by ruling.** H's test "keeps the message for `--reveal` only" asserted `diagnostic: boom at /private/fixture/path` in the revealed output. A22 ruled that contract wrong, so the test now asserts the opposite: the message and stack never appear, and the diagnostic is the error class. This is not a weakened test.

**Tests.** `test/host-check.test.js`: each closed set with a sentinel value, checked against the default and the `--reveal` output. One run seeds a sentinel in every input at once (config fields, Caddyfile marker, hosts, tls paths, `basic_auth`, redirect query, Tailscale status and serve routes, lease project, lookup error, `security` output, hostname, home). The default output must contain none of them, and `--reveal` none of the ones that reach codes or reasons. A further case covers the CLI's failure line with a code that is not code-shaped. Run against the module as merged in H, every new case fails except the one pinning the default `direct`, which H already got right.

## 2026-10-14 — #1380/#2142: a read-only host check says what this machine's names, Caddyfile, certificates and trust actually are

<!-- prawduct: type=feature | scope=host-migration-check-1380 -->

#1380/#2142 chunk H, of two (H, then G, the migration guide). Branch `feat/1380-host-check`. The contract is chunk H of the host-migration follow-ups packet (TC-Lane-A's plan for #1380, not in the repository), as corrected by the Architect's A11 and accepted in A12.

**Why.** After a host migration nothing reports the host's actual ingress facts side by side: the tailnet name, the configured names, which Caddy site answers which name, whether each site's own certificate carries it, which serve routes exist, and whether the local root is trusted. Operators found the gaps one broken link at a time.

**What changed.**

- `scripts/host-check.js` (new): `node scripts/host-check.js [--reveal]`. A standalone process, so it works right after a deploy with no restart.
- `lib/host-check.js` (new): ten rows (tailnet identity, configured names, Caddyfile sites, certificates, advisory proposed names, per-site coverage, serve routes against PortHub leases, local trust, local-only resolution, the transaction journal). Each row is `ok`, `drift`, `ambiguous`, `observed` or `unknown` with a reason. Exit 0, 3 (drift/ambiguous), 4 (unknown), 2 (usage).
- Read-only by construction: three allow-listed commands through `execFile` with no shell; one loopback GET of `/api/ports` with no credentials and no redirects; `config.json` read directly, never through the store. Bounded: 5 s and 1 MiB per command, 20 s per run, file size caps, at most 64 names (more → `names` unknown, non-zero exit).
- Redacted by default with stable tokens; `--reveal` adds a PRIVATE banner and still never shows credentials, `basic_auth` hashes, key bytes or query strings, because they are never collected.
- The journal row reads "journal inspection unsupported in this version; not checked": it claims nothing it did not look at.
- Over HTTPS the `/api/ports` read keeps TLS verification. A certificate that cannot be verified for 127.0.0.1 makes the row `unknown` (`tls-unverified`), with no insecure retry and no lease data. The port comes from the installed server's launchd plist, then config.
- These follow the Architect's ruling A15 on five choices made while building. (1) Journal wording; (2) an undeclared tailnet name with no Caddy site is `observed`, and nothing else is claimed to answer it; (3) synthetic PEM certificates inside JSON; (4) logs silenced only inside the standalone script; (5) TLS verification kept, so the row is `unknown` instead.

**Tests.** `test/host-check.test.js` with synthetic fixtures under `test/fixtures/host-check/` (Tailscale field names checked against a live `tailscale` 1.102.3, keys only). T-H0 runs the real script under a preloaded spy (`spy-preload.js`) and asserts no file write, no database open, no `store.init` or file logging, only allow-listed commands, one credential-free loopback request, and no key file read. T-H1 to T-H7 cover every state and reason, per-site coverage, redaction both ways, leases, trust, the budget and the three A12 carry-ins. The certificates are kept as PEM text inside `certs.json`, because `.gitignore` excludes `*.pem` and `*.crt`; their signing keys were discarded.

## 2026-10-14 — #2403: the Master's bridge credential is reconciled before boot can create a Master

<!-- prawduct: type=bugfix | scope=master-boot-credential-order-2403 -->

#2403, one chunk. Branch `fix/2403-master-boot-credential-order`, from `origin/main` `add3a9ea`, on the PM's dispatch and the Architect's approval with corrections.

**Why.** At boot the Master auto-start ran before `listen`. It minted a pending credential and handed it to the pane in the background. Then the server reconciled the previous process's credentials in `onListening`, which revokes every pending row. That included the auto-started Master's own credential while it was mid-handoff. The Master ran, and every bridge call it made was refused with `BRIDGE_CREDENTIAL_REQUIRED`.

**What changed.**

- `lib/master.js`: `bootMaster()` runs the reconciliation, unconditionally, and then the auto-start if it is on. It is never fatal. A failed reconciliation is logged, reported as `error` on its result, and auto-start still runs: minting supersedes every live row in one transaction.
- `server.js`: the auto-start block is one call to `bootMaster()`, still before `listen`. The reconciliation in `onListening` is deleted. Every other way to create a Master is a request or the gateway's pass, and neither starts before `listen`.
- `docs/operator-bridge.md`: says when the boot check runs.
- Revocation semantics in `bridge-principal` and `bridge-store` are unchanged.

**Tests.** `test/master-boot-order.test.js` drives `bootMaster` with the real store and FIFO handoff:
- The pane reads only after boot returns. The old order is kept as a failing negative control.
- Cases: prior pending, active survivor (and tmux silent), a Master that did not survive, auto-start off, a handoff never taken (read through `settled()`), superseded, a failed reconciliation, a throwing launch.
- Two structural guards pin the callers that can create a Master and `server.js`'s placement. They pin positions in source, not run-time order.
- Swapping the order inside `bootMaster` turns 6 of the 13 red.
- `test/master.test.js`: the auto-start pin matched the old inline block's source text. Its contract (boot honours `autoStart`, and a throwing launch is never fatal) moved with the code into `bootMaster`. The test now exercises `bootMaster` and pins that `server.js` calls it, so the guarantee is the same and the check is stronger.

## 2026-10-12 — #2229: the launch-isolation override's two switches, the way to them from a refused launch, and the line for a session running under one

<!-- prawduct: type=feature | scope=codex-override-2229 -->

#2229 Chunk 02, the issue's last: the override on screen. Branch `feat/2229-02-override-screens`, from `origin/main` `78b13a7e`, with `main` at `c7251728` (chunk 01c) merged in before the guides and this entry, on the Integrator's word.

Visual change: yes. Two new switches, one button on a launch-failed message, one new line in Launch readiness.

**Why.** Chunks 01a to 01c built the override, its launch path and `tc`'s wording, and left it settable only through its routes. Nothing on the dashboard offered it, and a refused launch named a setting the operator had no way to reach.

**What changed.**

- `public/ui.js`, Global Settings, "Launch isolation override": the install-wide switch. It says it covers every project and the Project Master.
- `public/ui.js`, a project's Settings, "Launch isolation override": that project's switch. It says when the install-wide override already covers the project, whatever the switch reads.
- Both switches read `GET /api/launch/isolation-overrides` and write its `PUT` and `DELETE` routes through the page's `api()`, with no body, and never a settings route. Each shows what the server answered and is read again after every change, the refused ones included. Settings that were not read are said to be unread, never shown as off. A page the server does not take as the operator's is told so and offered nothing.
- Both carry the sentence each overridden launch's record carries. The screen holds its own copy (the override routes do not send it) and a test holds it equal to `sessions.ISOLATION_OVERRIDE_RISK`.
- Turning one on where no login is in force: the server answers `403 LOGIN_GATE_REQUIRED`, and the switch stays off and says a login must be in force. The switch is still offered there, with a hint that says so before the click, because turning one off works without a login.
- `public/landing.js`: a launch refused as `version_unknown` or `version_unverified` carries one button, "Open launch isolation settings", which opens the project's Settings with the switch in view and focused. A page that would not be offered the switch (signed out while a login is in force) is told who can instead. No other refusal carries it.
- `public/ui.js`, Launch readiness: one line for the project's running session, read from `GET /api/launch/isolation`: "running under the operator's launch isolation override" with the version read and the refusal set aside, or "override unproved" with the server's reason. Nothing for any other row, and no session is called isolated.
- `public/style.css`: the switch keeps its checkbox in the tab order under the house toggle's look (the existing settings toggles hide theirs), with a focus ring; the button on the message.
- Docs: `docs/user-guide.md` (where the switches and the button are; the readiness line), `docs/engine-guide.md` (the same, under "The operator's override"). In `docs/user-guide.md` the sentence that told the reader a second time to skip Codex's update prompt is removed (a note from the review of #2377).

**Limits.** The line is about a running session only: a launch that has ended has no row in the inventory and no line. Its own six-second timer removes the button, or using it removes it sooner; an earlier toast timer can hide the message first, leaving its button focusable off screen until that six-second timer fires (#2339). The switch is reachable from the project's Settings at any time. The session page's relaunch refusal has no button: that page has no way into the dashboard's Project Settings, and the refusal's own text names the override. A session's own page and the Project Master's settings are offered no switch.

**Tests.** New `test/launch-isolation-override-ui.test.js`, run against the shipped functions lifted from `public/`: what each switch says; who is offered it (signed in, no login, signed out, not the operator's page, settings unread); what each answer to a change is told; the request each switch sends and the re-read after it; the refusal's button for the two version refusals and no other; the wiring into both modals; no switch on the session page. `test/launch-readiness-panel.test.js`: the line for a marked row, an unproved row, every other row, another project's row, the Project Master's, and a failed read.

**Browser check.** Done on `2c088fee`, 22:33 to 22:45 PDT on 2026-10-12, by an automated browser run; not yet seen by the Operator. Two scratch servers (no login; a login in force), desktop, 375 and 320. The refused launch's button was read again on `f7c3974a` (22:55 to 22:57 PDT, automated, one scratch server, no login); the switches and the panel line were not read again. Not covered: a real phone, a screen reader, the button reached inside six seconds by a person, the signed-out and not-the-operator wording on screen.

## 2026-10-12 — #2229: `tc` names a session running under the operator's override, and stops advising a relaunch that would change nothing

<!-- prawduct: type=feature | scope=2229-01c-tc-override-wording -->

#2229 Chunk 01c: what `tc` prints for a row of the isolation inventory that carries chunk 01b's mark. Branch `feat/2229-01c-tc-override-wording`, from `origin/main` `9b803ae9`, with `main` at `78b13a7e` (chunk 01b) merged in before the docs and the final tree. The code and its first tests were built beside 01b against the field its plan fixed; the two guides and this entry waited for 01b's merge, on the Integrator's word.

Visual change: no. No file under `public/` changes; what changes is text `tc` prints in a pane.

**Why.** A session the override let start is not isolated, and a relaunch starts it the same way while the override stands. `tc sessions isolation` told the operator to end and relaunch exactly those sessions and offered their ids to `--replaced`. Under `tc whoami` the server's line named the override only at the end of the row's reason, which is the part a notice cut to a page's room loses.

**What changed.**

- `lib/tc-verbs.js`, `tc sessions isolation`: a row with the mark prints `NOT ISOLATED (operator's override)`, after the plain `NOT ISOLATED` rows. The count line says how many of the not-isolated run under the override, and nothing of it when none do. Such a row is left out of the relaunch sentence and of the `--replaced` ids; when both kinds are present the sentence adds "except those marked (operator's override)". One closing sentence names the marked sessions and says what a relaunch does. When only marked sessions are not isolated the list says "Apart from the sessions under the operator's override, no live session needs relaunching", never a bare all-clear.
- `lib/tc-verbs.js`, the server's attributed line under `tc whoami`, `tc capabilities` and the state step: for a marked row it reads "recorded as not isolated, started under the operator's override (a relaunch can isolate it only on a Codex version TangleClaw has verified; on the same version it starts the same way while the override stands, and is refused once the override is cleared)", before the row's reason.
- `tc`'s own `Launch isolation:` line is unchanged. It is read from the pane alone, and a binding can be another launch's, so nothing in the server's row alters `tc`'s own advice (queue Rulings items 11, 13 and 56).
- `tc` reads one thing of the row: verdict `not-isolated` and `override.launchedUnderOverride === true`. Any other shape of the field, a mark beside another verdict, and a row carrying `overrideUnproved` keep the ordinary label and the ordinary advice to relaunch.
- Docs: `docs/engine-guide.md` (the cutover steps, and the server's second line), `docs/user-guide.md` (the `NOT ISOLATED` row).

**Corrected at the build.** The release's wording said a relaunch isolates such a session "only on a verified Codex or with the override cleared". Clearing the override isolates nothing: on the same Codex version the next launch is then refused. Found by the cumulative review and by the decider, and reworded before anything was pushed.

**Limits.** The mark is the server's, and ages out with the activity log (chunk 01b's limit): a long-lived overridden session then reads unproved and is listed for relaunch again. Not run against a real overridden Codex pane: that waits for the deploy.

**Tests.** `test/tc-verbs.test.js`: the fleet list with a marked row, with only marked rows, with a mark whose detail is null, with malformed and unproved marker shapes, with a mark beside each other verdict; no positive verdict; a fleet with no mark printed exactly as before; and the same renderers over rows written by the real `lib/launch-isolation-inventory.js` for a marked project session, a marked Project Master, an unproved session and a plain one. `test/tc-pane-identity.test.js`: the server's line, the Project Master's row, `tc`'s own line the same bytes with and without the mark for six readings of the pane, an unproved row, and the cut notice keeping the override.

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
