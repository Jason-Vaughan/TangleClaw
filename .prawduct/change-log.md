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

## 2026-10-24 — W5-REL follow-up: record v5.36.0 as released

<!-- prawduct: type=docs | scope=w5-rel-v5.36-status-post-release -->

The post-publication status correction W5-REL's plan amendment 1 owed, on the Integrator's dispatch after `release.yml` published. Docs only: `docs/releases/v5.36-status.md` and this entry.

- **Code released: Yes.** #2570 merged as `fcef8dfe` at 03:24:50 UTC; `release.yml` run 40058196591 and `Tests` run 40058196531 concluded `success` on it; the annotated tag `v5.36.0` on origin peels to `fcef8dfe`; the GitHub Release is published, not a draft or pre-release, at 03:37:52 UTC. Each fact was read again by TC-Lane-A at 03:40 UTC, not copied from the dispatch.
- **Production updated: No.** No deploy is authorized; read-only, the live checkout is at `415eb036` (`v5.35.0`) and `/api/health` answers version `5.35.0`.
- **Feature activated: not proven**, since nothing of v5.36.0 is live.
- "What is left" now names only the Operator-authorized deploy and its reading.

## 2026-10-24 — W5-REL: prepare the v5.36.0 release

<!-- prawduct: type=chore | scope=w5-rel-v5.36.0-release-prep -->

v5.36.0 Wave 5 chunk W5-REL, under charter A13 `GRANT-V536-W5REL-20261023` as corrected by A14 (charter `4fa6925c`); plan rev 1 (`dfe7e337`) and amendment 1 (`9d46cb99`), approved by the Integrator.

**Merging this pull request is the release.** `.github/workflows/release.yml` runs on the `version.json` change on `main`, tests the merge commit, tags `v5.36.0` on it and publishes the GitHub Release. Nobody tags by hand (this repository's CLAUDE.md exception; `docs/release-process.md`).

**What changed.**
- The 9 fragments under `changelog.d/` (1 added, 5 fixed, 3 internal) were compiled into `[Unreleased]` by `lib/changelog-fragments.js`, promoted to `## [5.36.0] - 2026-10-23` by `version-bump`'s own promote function, and deleted in the same commit, the path v5.35.0's release took. The charter's first text named 8 fragments; `main` held 9, and A14 corrected it.
- `version.json` 5.35.0 → 5.36.0. There is no `package.json` in this repository.
- `node scripts/release-prepare.js` moved the README clone pins and added the `[5.36.0]` line to the released-sections lock, additions only.
- `docs/releases/v5.36-status.md`: the release's status before the merge, every finish line "No" with what each owes. A read-only upgrade rehearsal on a scratch copy of the live store (schema 68 before and after, 77 tables, row counts unchanged, `quick_check` ok, 0 foreign-key violations; scratch deleted).
- Release notes: 4,682 of 120,000 bytes (`scripts/release-notes-gate.js`).

**Parity.** `docs/tc-cli-reference.md` was already current and is unchanged. `FEATURES.md` lacked three shipped behaviours; the Integrator widened the lock for one clause each in the existing entries: `tc docs lock`/`unlock` in the shared-doc revision record, finalize's coordinator caller (#2556), and `scripts/record-test-run.js` in the CI-as-suite-evidence entry (#2521). #2547 fixes existing behaviour and needs no entry.

**Changelog:** none of its own; this pull request consumes the fragments.

## 2026-10-24 — W4-B #2544: the dead-export walker reads templates and spreads; first removal batch retires lib/soak/

<!-- prawduct: type=refactor | scope=w4b-2544-retire-soak-dead-exports -->

v5.36.0 Wave 4 chunk W4-B, under `GRANT-V536-BATCH1-20261023`. The first D4 removal batch of epic #2498's dead-export audit, accepted at step 0 by PM Addendum A11 (option A) and Architect A436. #2544 stays open for the remaining batches.

**Why the walker came first.** Hand-checking the batch showed the audit's dead list was wrong in both directions.
- `scripts/_require-graph.js` blanked a template's `${…}` with its text, so `${m.name}` was no read. Its member-use regex also took the last dot of `...` for a member access, so `[...m.name]` was none either.
- Those two blind spots put 13 read exports on the dead list. One is product-used and test-pinned: `scripts/soak.js` prints `lib/soak/local`'s `OPERATOR_USERNAME`, and `test/soak-cli.test.js` asserts it. Dropping the export fails that test (pass 0 / fail 1), and restoring it passes (pass 1).
- The old mask also ended a template at a nested template's backtick, so the word "runtime" in `scripts/ttyd-runtime.js`'s message text counted as a whole-module use. That hid 4 genuinely dead `lib/ttyd-runtime.js` exports. They are recorded in the baseline, not removed: that file is outside this batch.

**What changed.**
- `memberUsesOf` reads a mask that keeps each `${…}`'s code (nested templates handled, and a regex right after `${` read as a regex), and lets a spread's dots precede the identifier.
- The default mask, which the require scanner, the dynamic-prefix extraction and `splitArgs` read, is byte-identical to main's on every tracked JS file. Its own nested-template limit for require edges is #2566.
- The 33 dead exports under `lib/soak/` are retired by export entry alone, since each is still used inside its own module.
- Baseline: 234 − 13 + 4 − 33 = 192.
- `docs/test-pyramid.md` records the batch and the walker's new reads.

**Verified.**
- New `test/require-graph.test.js` cases each fail on the old walker. They also pin that a template require keeps its literal-prefix bound and that `splitArgs` balances a template argument under either mask.
- Ratchet: `--check` was red on 33 stale entries before `--write-baseline`, green at 192 after, and red on a probe export with no reader (reverted).
- The `audit-source-readers` output is unchanged.
- Narrow soak and release-certification run: 1038/1038.

Critic: 0 blocking. R-2 (regex after `${`) was fixed and verified. R-1 (suite evidence, full suite under SUITE_SLOT), R-3 (#2566), R-4 (this entry, deferred until W4-A merged), R-5 and R-6 were accepted on the record.

**Changelog:** `changelog.d/2544.retire-soak-dead-exports.internal.md`.

## 2026-10-24 — W4-A #2531 + #2546: two intermittent tests wait for the behaviour, not a fixed delay

<!-- prawduct: type=fix | scope=w4a-2531-2546-timing-free-tests -->

v5.36.0 Wave 4 chunk W4-A, under `GRANT-V536-BATCH1-20261023`. Tests only; no library change.

**Why.** Both failures measured the host, not the code. The tmux alternate-screen test slept 0.5 s and then expected `less` to have switched screens; one CI run (Tests 39718444172) saw it had not yet. The check-watch monitor timer test slept 60 ms and expected two passes; one full local suite saw one.

**What changed.**
- `test/tmux.test.js` gains `waitForCapture`, which polls the whole `capturePane` result (lines and screen mode) up to 10 s and fails with the last lines. `waitForPane` is now built on it, with the same signature, return value and failure text for its callers. The alternate-screen test waits until `less` is on the alternate screen showing `hello-alt-test`, then keeps its assertions.
- `test/check-watch-monitor.test.js` waits up to 10 s for the second timer pass instead of 60 ms. The existing `listed >= 2` assertion reports the count on timeout. The stop proof and the double `start()` are unchanged.

**Verified.** Mutation checks, both reverted: piping into `cat` instead of `less` failed the alternate-screen test with its timeout message, and a one-shot `setTimeout` in place of the monitor's `setInterval` failed the timer test with `listed 1 time(s)`. Each case passed 20 sequential and 20 concurrent repeats.

Critic: 0 blocking; R-1 (stale suite evidence, full suite runs on the frozen head under SUITE_SLOT) and R-2 (the launch-env-injection tests' 0.5 s sleeps, outside this chunk, filed as #2565) accepted on the record.

**Changelog:** `changelog.d/2531.timing-free-pane-and-monitor-tests.internal.md`. No docs change.

## 2026-10-23 — W3-B #2557: tests show a slow project scan or version probe cannot delay the switchboard

<!-- prawduct: type=chore | scope=w3b-2557-slow-route-switchboard -->

v5.36.0 Wave 3 chunk W3-B, under `GRANT-V536-BATCH1-20261023`. Tests only, by PM Addendum A9 (TESTONLY).

**Why tests only.** On `main`, #2557's first criterion already held: the `/api/projects` walk and git reads run in the `dir-scanner` child, and the OpenClaw version probe is an async `exec` with a per-connection cache. I measured before building:
- A fixed harness (the real `handleRequest`, scanner stubbed instant) took 19 ms for 60 projects and 38 ms for 120, with no measurable loop delay.
- On the live server, a switchboard read polled through a 5-10 s `/api/projects` had a worst case of 114 ms, which cannot be attributed to this route on a shared server.
- The dashboard's poll awaits each response.

The planned yield-between-projects and single-flight were therefore dropped as cosmetic or unmeasured. The second criterion, regression tests, was missing.

**What changed.**
- `test/api-projects.test.js` polls `GET /api/sessions/<p>/medusa/messages` through a `GET /api/projects` whose scanner reads are each slowed by an async 200 ms.
- `test/openclaw-version-route.test.js` does the same around a forced version probe whose ssh read takes an async 600 ms.
- Both fail when a switchboard answer or the event-loop delay reaches 500 ms.

Mutation checks: a 1.5 s synchronous wait before each facts read, in enrichment, or in `readVersion` failed the tests. Each run reported a 1.5 s read or `ECONNRESET`. Each wait was reverted.

**Changelog:** `changelog.d/2557.slow-route-switchboard-tests.internal.md`. No docs change.

## 2026-10-23 — W3-A #2554 + #2556: finalize drain and coordinator authority, Master close, `tc docs lock`

<!-- prawduct: type=fix | scope=w3a-2554-2556-finalize-drain-cli -->

v5.36.0 Wave 3 chunk W3-A, under `GRANT-V536-BATCH1-20261023` / PM A7.
- **Approvals:** PM Addendum A8 (charter `7f51d9c9`) ruled D1–D4. Architect A433-R1 accepted the step-0 plan rev2 (`2de27817`), including the bounded `server.js` close-route edit, and the Integrator released it.
- **Branch:** `fix/2554-2556-finalize-drain-cli` from `origin/main` `671015db`.

**What changed (#2554).** `tc finalize` refused `EXCHANGES_OPEN` on a lane that owed nothing.
- `store.medusaExchanges.listOpenForRecipient` takes an opt-in `hubBoundOnly`, and only `_obligations` in `lib/session-finalize.js` passes it. A `send_pending`/`send_unknown` row has no Hub id, so the recipient could never acknowledge it. The default is unchanged, so the retired-recipient sweep still ends such rows.
- `close()` in `lib/medusa-exchanges.js` admits a `master` caller for exactly what the Master sent: `origin='send'`, no sending project, its listener key, and not a system send. It is recorded as `master` with `launch` proof.
- `server.js` close route: on the Master's mount, a verified Master launch is passed as `{kind:'master'}`. `exchangeCaller` is unchanged.

**What changed (#2556).**
- `lib/session-finalize.js` gains a `coordinator` mode. With no control assignment open, the project the target's own `workloadNudge.coordinatorProject` names covers the target's active session, or its latest one so that a repeat can finish. Every delegated gate applies, plus `409 NOT_ON_TRUNK`. A session outside that coverage answers `403 SESSION_NOT_COVERED`, the guard Architect A433 required, because there is no assignment to name.
- `tc docs lock <doc> [--ttl]` / `tc docs unlock <doc>` in `lib/tc-verbs.js`. `bin/tc` gains a `deleteJson` helper for the unlock.
- The `--step 0` seam-review hint is descoped by A8: `review request --type seam` lives in the external Prawduct plugin, not in this repo.

**Tests:** `test/api-session-finalize.test.js`, `test/medusa-exchanges.test.js`, `test/master-medusa.test.js` (the Master mount's route harness) and `test/shared-docs-attest-route.test.js` (the live `tc docs` harness).
**Docs:** `docs/session-finalize.md`, `docs/medusa-delivery.md`, `docs/tc-cli-reference.md`, and the `workloadNudge` row of `docs/configuration-reference.md`.

## 2026-10-23 — W2-B #2547 + #2555: the Master is told of waiting candidates, and terminal residue no longer holds a wake

<!-- prawduct: type=fix | scope=w2b-2547-2555-master-candidates-composer -->

v5.36.0 Wave 2 chunk W2-B, under `GRANT-V536-BATCH1-20261023` / PM A4.
- **Approvals:** the Integrator's step-0 approval and rulings (`bd1a6b15`); PM Addendum A6 ratifying `docs/operator-bridge.md` and `docs/engine-guide.md`; the Integrator's approval of `docs/medusa-delivery.md` (`15f27f02`).
- **Branch:** `fix/2547-2555-master-candidates-composer` from `origin/main` `5b8386a2`, merged with `f4fcac55` (W2-A).

**What changed (#2547).** A submitted candidate was only stored, so it waited until something unrelated woke the Project Master, and the per-launch limit then refused that session's next one.
- `tick()` in `lib/bridge-gateway.js` now sends the Master one notice per pass naming the newly waiting candidates. It carries ids only, never text, at most ten plus a count.
- Each candidate is remembered as told under `candidate:<id>` only after the send resolves. The id alone is the key, because a merge moves a version and the Master made the merge.
- A stopped Master is started through `_masterLive()`, the backoff `_summonMaster` already had, so one window serves routes and candidates.
- The pass's cleanup learns the `candidate:` key. Without that it would have forgotten the key on every pass and re-told the Master every 15 s.
- 10 tests in `test/bridge-gateway.test.js`.

**What changed (#2555).** Two composer states held every switchboard wake.
- A terminal device-attributes reply (`0;276;0c`) left in a Codex composer read as typed input.
  - `isTerminalReplyResidue` and `_terminalReplyRegion` in `lib/medusa-wake.js` let `_assessPane` read a composer row holding only such replies as at the prompt. The guards are the stranded-nudge excuse's: no glyph-led row below it, and never excusing a missing at-rest marker.
  - Mixed text is still input. `_composerEmpty`, which four modules read, is unchanged.
- A stranded nudge wrapped over several rows survived the single line-kill.
  - `_clearPromptLine` in `lib/tmux.js` now repeats the line-kill while what is left is how the nudge began, at most one per row and 12 in all. Anything else refuses the paste, as before.
  - A residue-only composer is cleared without going to the draft store.
  - Both sends go through one `_lineKill` helper, so the `tmux -t` site count is unchanged.
- 13 tests in `test/medusa-wake-stranded-nudge.test.js` and `test/tmux-draft-capture.test.js`.

**Spec corrections.** The issues name `reconcile` (it is `tick()`) and `clearStrandedSwitchboardNudge` (it is `_clearPromptLine`). They put `composer-has-input` in `lib/tmux.js`; it is decided in `lib/medusa-wake.js`. They asked to strip the reply; it is excused only when it stands alone.

**Review.** Cumulative Critic: 0 blocking.
- Its note (a remnant matched as any substring) was fixed to the prefix rule, and `verify-resolutions` came back clean.
- Its two warnings, stale test evidence and records deferred until W2-A merged, were accepted on the record.

## 2026-10-23 — W2-A #2195: the same startup dialog is recorded once

<!-- prawduct: type=fix | scope=2195-launch-blocker-idempotent -->

v5.36.0 Wave 2 chunk W2-A, under `GRANT-V536-BATCH1-20261023` / PM A4.
- **Approvals:** the Integrator's step-0 seam and plan approval (`0ccd0a29`).
- **Branch:** `fix/2195-launch-blocker-idempotent` from `origin/main` `5b8386a2`.

**What changed.** `store.sessions.setLaunchBlocker` (`lib/store/sessions.js`) logged `session.launch_blocked` on every call. The boot watch records a dialog when it first sees it; a send's reconcile holding a row read before that write saw no blocker and recorded the same dialog again, so one dialog made two activity entries.
- The store now decides under one `BEGIN IMMEDIATE`: when the readable stored blocker has the same code, it writes nothing, logs nothing, and returns the session as it stands (the first `observedAt` is kept).
- A different code, a stored blocker that cannot be read, and a dialog shown again after it was cleared are still written and logged.
- Return contract: null now means only "this session takes no blocker" (no code, or no such active session). The same-code call returns the session, so the reconcile reports the stored blocker instead of its stale snapshot's none. The boot watch ignores the return.
- Tests in `test/startup-dialog.test.js`: the four store cases, and the stale-snapshot reconcile race (red on `5b8386a2`).

## 2026-10-23 — W1-B #2521 (+ #2371): a suite record Prawduct cannot under-count, and the #2371 cutover made exact

<!-- prawduct: type=fix | scope=w1b-2371-2521-suite-evidence -->

v5.36.0 Wave 1 chunk W1-B, under `GRANT-V536-BATCH1-20261023`.
- **Approvals:** the Integrator's approval of plan rev 2 (`2dde80a7`); the step-0 seam accept (INT `99a0d6cb`, Architect A428 `c0c1999a`); PM Addendum A3 for the tier ledger.
- **Branch:** `fix/2521-record-test-run` from `origin/main` `415eb036`, merged with `de32a435` (W1-A).

**What changed.** Prawduct 3.6.1's recorder counts only the `<testcase>`s beneath a top-level `<testsuite>`. node:test's junit report also writes cases directly under the root and inside one `<undefined name="root">` element. On #2521's kept report, Prawduct's own parse therefore read 12,786 of 21,997 leaves.
- `lib/test-results.js` gains `prawductView` (that reading, modelled) and `hoistToTopLevelSuites`. The hoist renames `<undefined>` and wraps runs of bare top-level cases. It refuses any other top-level shape, and it checks leaf, failure and skip conservation before returning. On the kept report, Prawduct's parse of the hoisted copy reads all 21,997.
- `scripts/record-test-run.js` runs `scripts/suite-evidence.js` (either mode) and reconciles the raw report. It then hoists, ingests with `prawduct-hook test-evidence record --from-junit`, and re-reads `.prawduct/.test-evidence.json`, refusing on any count that disagrees.
- It keeps both reports by head and writes the receipt `.tangleclaw/test-recorder.json` on every outcome.
- The record names one clean commit (INT pre-suite review, `32a8f36f`): the checkout must be clean at the start, and unchanged and clean after the suite and again before the ingest; Prawduct's `evidence_tree` must equal HEAD's tree.
- The same gap shows in v5.34.0's 2026-10-19 release record: 12,737 passed + 1 skipped against 21,925 leaves in its kept report, exactly what `prawductView` predicts (that run was green).
- The new test is declared in the small tier (`test/tiers.json`, regenerated `.testament.toml`).

**#2371 stays inactive.** The gitignored activation packet (`.tangleclaw/plans/w1b-2371-activation-packet.md`) is a proposal only. It does three things:
- It shows that the W4-03 path would carry the same under-count into CI-as-suite evidence: `suite-evidence.js` copies the `<undefined>` container into its merged report.
- It routes that path through `record-test-run.js`, which drops the `test_command` cutover step.
- It carries full replacement texts for #271, #273 and #282, with the Architect-approved conservation formula and a page-digest placeholder.

**Corrected on the way.** Two corrections:
- The charter's conservation formula `skipped == 0` refuses every green run (`main` 415eb036 CI run 39974498081 has 19 ledger skips). The Architect approved the replacement formula as a proposal.
- My plan claimed #271/#282 had been replaced. They had not: #271 is TC-Lane-A's copy of the Builder overlay (#273 is identical).

**Owed.**
- The full suite, through `record-test-run.js`, under `SUITE_SLOT`.
- The `docs/lane-ci-evidence.md` follow-up under #2371, which retires the raw-report path it still describes.
- The upstream Prawduct report for #2521, which needs the Operator's approval of the bytes.

Critic: 0 blocking; R-4/R-5 fixed in `e7bec1f0`; R-1/R-2/R-3/R-6 and O-1 accepted on the record. Refs #2521, Refs #2371.

## 2026-10-23 — W1-A #2558: v5.35.0 recorded as released, a manual `Tests` run, and the doc-only fast path written down

<!-- prawduct: type=chore | scope=2558-v535-sync-dispatch-docpath -->

v5.36.0 Wave 1 chunk W1-A, under `GRANT-V536-BATCH1-20261023`, on the Integrator's approval of plan sha256 `df81a8c1…54e1a6` and its step-0 seam accept. Branch `docs/2558-v535-sync-dispatch` from `origin/main` `415eb036`.

**What changed.** `docs/releases/v5.35-status.md` now reads released and deployed, each finish line from a read-only measurement taken 2026-10-23 18:24 UTC: #2553 merged as `415eb036`, `release.yml` concluded `success` on it, the tag `v5.35.0` peels to it and the Release is published; the live checkout is at the tag, the server started after the Release, health answers `5.35.0`, the store reads schema 68, and the pre-deploy backup was found and read (schema 68, `quick_check` ok), not restored. `docs/tc-cli-reference.md` applies to 5.35.0; the roster did not change between the two tags. `.github/workflows/test.yml` gains `workflow_dispatch:`, so a commit whose push webhook was dropped can be tested by hand; `test/ci-workflow.test.js` pins it and was seen failing without it. `docs/test-pyramid.md` says when a pull request skips `SUITE_SLOT`: `prawduct-hook check-pr-doc-only` exits 0 on its committed diff, and then Stage 1 plus GitHub CI are its gate.

**Corrected on the way.** The charter and the issue name `scripts/check-pr-doc-only.js` and `npm run test:stage1`; neither exists (no `package.json`). The real commands are documented instead, as the Integrator ruled. The issue's `0cd77e71` (#2552) and `dcab8e74` (the dropped webhook) are not objects in this repository; #2552 is `1e608f28`, already cited. This pull request is not itself doc-only, so it takes the full suite gate.

## 2026-10-23 — W5-REL: prepare v5.35.0

<!-- prawduct: type=chore | scope=w5-rel-release-5.35.0 -->

v5.35.0 release chunk W5-REL, under the batch charter (sha256 `b87fd37a…f98b97`) and the corrected sprint plan (sha256 `edb64f45…3d87ab`), released by the Integrator at queue rev 249. Branch `chore/release-5.35.0` from `origin/main` `1e608f28`. Prepared as a DRAFT pull request: marking it ready, merging, tagging and deploying are held until the Operator authorizes the release cut, relayed by the PM.

**What changed.** `version.json` goes from 5.34.0 to 5.35.0, a minor bump because the compiled section holds Added and Changed entries and no `BREAKING` marker. `CHANGELOG.md`: the 24 fragments under `changelog.d/` were compiled into `[Unreleased]` with `lib/changelog-fragments.js` (`readFragments`, `compileFragments`, `spliceIntoUnreleased`), and that body promoted to `## [5.35.0]` with `version-bump`'s own `_promoteUnreleased`, leaving `[Unreleased]` empty, as a wrap's release cut does; the 24 fragment files are deleted. The heading was first stamped 2026-10-22, `version-bump`'s local-date convention read on this host in PDT, and restamped `2026-10-23` on the PM's authorization once the local date had turned; the lock hashes only the body below the heading, so its `5.35.0` line is unchanged. `node scripts/release-prepare.js` exited 0 and only added: the two `README.md` clone pins now name `v5.35.0`, and `test/fixtures/changelog-released-sections.lock.json` gains the `5.35.0` line. The extracted release notes are 13,588 of the gate's 120,000 bytes (`node lib/changelog-notes.js 5.35.0`, `node scripts/release-notes-gate.js`). `docs/releases/v5.35-status.md` is new, marked pre-publication: the delta range `v5.34.0` `da4b3afe` to `1e608f28` with each count's command, the three finish lines as true at this head (prepared, not yet released; not yet deployed; activation pending the deploy), Waves 1 to 4, schema 68 unchanged with the same migration chain, and every open or Operator-held item as it stands.

**Upgrade rehearsal.** The Integrator asked for one because Wave 3 moved the store's code into modules. A `sqlite3 .backup` copy of the live store was opened by `c3546e63`'s own `lib/store.js` in a private scratch directory with `TANGLECLAW_HOME` pointed there, never by `server.js`. Schema 68 to 68 with no migration run, integrity ok, no foreign-key violations, no bridge schema problems, no table added or lost, and no row count changed. A second open changed nothing. The scratch directory was deleted and confirmed gone; only counts and verdicts were recorded.

**Not touched.** No code, workflow, rule or issue. `docs/tc-cli-reference.md` still reads "Applies to: TangleClaw 5.34.0", and `release-prepare.js` does not move that line; it is outside this chunk's lock and is left for a follow-up.

Merging this pull request publishes v5.35.0 through `release.yml`, which tags the merged commit; nobody tags by hand. This chunk makes no deploy or restart.

## 2026-10-23 — #2498 Wave 4 records

<!-- prawduct: type=chore | scope=2498-test-pyramid -->

Wave 4 (v5.35.0) shipped six chunks of #2498, each with Architect exact-target acceptance and the Integrator's Merge Gate: W4-01 #2541 (head `0aa96a83`, merge `f5c6ceb9`, A417), W4-02 #2542 (`9f0a749f`, `1fb99f52`, A419), W4-03 #2543 (`2ddbce3b`, `68c4ff0e`, A420), W4-04 #2545 (`729eba52`, `f0882cae`, A421), W4-05 #2550 (`442303b4`, `49a5f096`, A422) and W4-06 #2551 (`1879857a`, `780ad331`, A423). #2498 closed on W4-06. #2371 stays OPEN: `scripts/suite-evidence.js` is built but declared nowhere, and its cutover (the workflow step, the gate declaration and the rule texts in the activation packet) is Operator-held. #2362 is untouched and OPEN. The consolidation work the audits found is #2544, #2548 and #2549.

`FEATURES.md` gains one "Test pyramid" entry under CLI / Tooling, with the ledger and guards, the stages, Stage 2, the audits, the Testament manifest and the proposed CI evidence path; the chunk PRs' FEATURES copy is folded into it. `CHANGELOG.md` and the six `changelog.d/2498.*.internal.md` fragments are left for release preparation, and no records fragment is added, because one would repeat them. Three earlier entries are corrected in place, as their chunks carried forward: W4-02's sentence on how `test/test-stage.test.js` pins the declared `test_command` (fixed in `9f0a749f` after CI's clone had no `.prawduct/project-state.yaml`), W4-05's finding labels (R-1/R-2, not W1/W2), and W4-06's record now says `PRODUCT_DIRS` was removed. The live log was past prawduct's archive threshold, so `prawduct-hook archive-change-log --apply` moved every entry but the newest two and one pinned entry, W4-01 to W4-05 among them, verbatim into `.prawduct/change-log-archive/2026-10.md`.

## 2026-10-23 — #2498 W4-06: `.testament.toml` generated from the tier ledger, and the test-pyramid docs finished

<!-- prawduct: type=feature | scope=2498-test-pyramid -->

#2498 W4-06, the last chunk of v5.35.0 Wave 4, plan r2 (W4-01 to W4-05 ticked at dispatch); Fixes #2498, Refs #2371 (open, proposed, Operator-held); #2362 untouched. Built on `feat/2498-w4-06-testament-manifest` from `origin/main` `49a5f096` under the Integrator's W4-06 release (queue rev 239, readback token `W4-06-READBACK-20261023T043335Z-49A5F096`), with two PM rulings relayed in the dispatch: `scripts/_require-graph.js` may only lose its unused `PRODUCT_DIRS` constant and export, with no graph behaviour change; and the PR may say `Fixes #2498` citing the existing #2544/#2548/#2549 and the Operator's pool setup, with no new Stryker or Testament-pool issue (this supersedes the plan's W4-06 completion mapping, which filed three).

**The manifest.** `node scripts/test-tiers.js --testament` writes `.testament.toml` (`manifest_version = 3`, `executor = "host"`, `env_inputs = [".node-version"]`, `batch_timeout_s = 1800`, `[setup] steps = []`) with one `files` suite per tier, its `files` the tier's paths from the ledger, and its `command` the stage runner's own `tierArgv` for the tier (guard and `--test-timeout` for small and medium) with `--test-concurrency=1` and Testament's `{files}`/`{junit}` placeholders, `one_file_per_process = true`. Taking the command from `scripts/test-stage.js` means a pool batch runs a tier exactly as its stage does; the generator loads the stage runner lazily because the stage runner loads this module at its top. An empty tier is refused by name rather than written, since Testament refuses a `files` suite with no files. `--check`, which Stage 1 runs, fails when the manifest is missing or differs from the generated text by one byte.

**What was verified and what was not.** The tracked manifest was read without error by Testament's own `manifest.py` and `files` adapter at v0.9.0, the tag the plan was written against, and at v0.12.1, the newest tag today. Testament's collector, run over `git ls-files`, put each test file in exactly one suite, and the three suites together equal `test/*.test.js`. The batch command it renders for the first file of each tier ran under node here (exit 0, junit written). No Testament run happened: `testament` is not installed on this host and no pool exists (D5). `test/test-tiers.test.js` pins the generator with a reader for exactly the TOML subset it writes, which throws on anything else: the tracked manifest's suites are the ledger, their union is the suite, each command equals the stage-derived one, the env input exists, and `--check` refuses a missing or hand-edited manifest that `--testament` then restores. The same file gains the Architect's A417 note: the helper-scan block's temp directory is removed in `after()` (24 `tc-tier-*` directories in the temp dir before a run and after).

**Docs.** `docs/test-pyramid.md` gains the manifest section: each key and why, what was checked, and the Operator's pool setup in Testament's own commands (CLI install, prompt-free SSH aliases checked with `ssh -o BatchMode=yes`, the tailnet, `coordinator install`, `runner add` with Node 22/git/tmux on the runner, the macOS Local Network approval, `projects allow tangleclaw --executor host` plus the owner secret, `invite`/`join`, then `testament onboard`). The queue's wording names `testament init`, but neither tag has such a command, so the page says so and documents the real sequence. Testament's agent-instructions block is deliberately not added to `CLAUDE.md`: it would send every session's tests through Testament, which is the lane rules' decision. The Stage 1 row and the classify/regenerate steps now name the manifest, and the audits' paragraph says `442303b4` instead of "this chunk's tree" (W4-05 PR review note). `CONTRIBUTING.md`'s stage list gains Stage 2 and the dead-export step and loses the stale "Stage 2 is not built yet" line, replaced by how to declare a new test file and regenerate the manifest. `FEATURES.md` has no script index to anchor, `data/*-guide.md` and `CLAUDE.md` need no pointer, and `test/tiers.json` is unchanged (no new test file).

**Records.** Fragment `changelog.d/2498.w4-06-testament-manifest.internal.md`; CHANGELOG and FEATURES entries in the PR body for the records PR. `scripts/_require-graph.js` lost the unused `PRODUCT_DIRS` constant and its export, which nothing read; `BARE_PATH` and the graph's behaviour are unchanged. Not touched: `.github/workflows/test.yml`, `.prawduct/project-state.yaml`, every gate and rule, every existing test's assertions.

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
