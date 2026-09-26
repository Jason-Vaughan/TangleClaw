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

## 2026-09-26 — Harness gate hardened before the certification run (#1245, Critic rev-20260926T030542Z-e93b8543)

<!-- prawduct: type=bugfix | scope=ttyd-1245 -->

Run 2 was stopped about 15 minutes in, by exact PID (the interrupt cleanup left nothing), because two warnings were gate defects.
- **W1, which could pass a leak:** a cut-off lsof reading (timeout, signal or buffer overflow) was read as complete. `lsofOutput` (lib, tested) keeps output only on a clean exit or lsof's ordinary exit 1; anything else is unmeasured, hence inconclusive.
- **W2, which could fail a clean run falsely:** the ledger matched PIDs alone, and macOS reuses them (about 28,800 `ps` spawns per soak). The identity is now PID plus `lstart`, and a process group whose live leader has a different start time counts as reused, not ours.
- **W3:** a failed binary probe is recorded in `reading.errors`, and the health row reports `managed: null` with "could not read which ttyd binary". It no longer reads as "not managed".
- **Notes:** the unused `POOL_TOLERANCE` was dropped. The `latestGeneration` comment was moved. The `installRuntime` comment now states the real fail-closed guarantee, not "exactly as they were". The configuration reference names the provenance check.
- **Smoke on the host:** packaged, 0 owned PTYs and 0 survivors (65 PIDs and 29 groups recorded); the control fails the gate with 177 held `/dev/ptmx` handles for 59 wedges.

## 2026-09-26 — Harness gate measures run-owned resources, not the global pool (#1245, chunk 07)

<!-- prawduct: type=bugfix | scope=ttyd-1245 -->

Architect ruling on the first packaged run (02:59Z): option (b) as modified.
- **What the first run showed:** the run of `dfae4e69` was clean on run-owned evidence (2000/2000 reaped, 0 wedges, 0 lingering, fds back). But the harness failed it on the GLOBAL PTY pool (34 → 44), which the live, unfixed Homebrew ttyd drove by wedging 5 children from real use during the soak. That run is kept as supporting evidence.
- **Recorded as they appear:** a `ProcessLedger` records the scratch ttyd, every descendant PID and every descendant process group from each 250 ms sample. An end-time walk would miss survivors that launchd has already reparented.
- **Run-owned PTYs:** from `lsof -F pn` on the recorded live processes, counting slave `/dev/ttys*` by name and `/dev/ptmx` handles by count.
- **The gate:** run-owned PTYs back to baseline, scratch ttyd fds back to baseline, and after cleanup no recorded PID or process group survives, nor holds a PTY. The global pool is diagnostic only.
- **Snapshots:** process-tree plus lsof snapshots at the baseline, before cleanup and after cleanup.
- **Frozen identity:** the report records the harness commit (and whether it was dirty) and the ttyd binary's sha256.
- **Bug found by smoke-testing the gate:** lsof exits 1 when a listed process vanishes, and the helper lost its stdout, so the control read as unmeasured. `readOwnedPtys` now keeps stdout whatever the exit code.
- **Mutation check:** the static no-drain control now fails the gate on 135 run-owned `/dev/ptmx` handles for 45 wedges (3 per wedge), against 0 at the baseline. The packaged candidate's smoke run held 0.

## 2026-09-26 — Review fixes for the owned runtime (#1245, Critic rev-20260926T005348Z-79b3ab22)

<!-- prawduct: type=bugfix | scope=ttyd-1245 -->

- **Provenance (R-2):** `verifyRuntime` now checks the manifest's recorded source and patch digests against `deploy/ttyd/inputs.json`. `--version` cannot tell builds apart, so a runtime built without the fix is refused.
- **Base directory (R-3):** `install.sh` passes `--base-dir "$HOME/.tangleclaw"`, the same base it writes everything else under.
- **Which binary runs (R-5):** the watcher's reading records the running binary (`ps -p <pid> -o comm=`), and the health row notes when it is not the owned runtime. The live certification can see whether the fix is actually in force.
- **Docs (R-1, R-6):**
  - The CHANGELOG no longer claims the packaged binary's acceptance before it has run, and no longer contradicts itself.
  - The configuration reference says where `TANGLECLAW_TTYD_RUNTIME` must be set.
- **Notes:**
  - A test keeps the two system-root declarations in sync.
  - The watcher's unused reading history became a single `_latest`.
  - The FEATURES wording on the wedge rule is corrected.

## 2026-09-26 — Owned ttyd runtime, part 2: one resolver, transactional install, fail-closed wiring (#1245, chunk 06)

<!-- prawduct: type=feature | scope=ttyd-1245 -->

R24 / ADR 0018 §1, §4.
- **`lib/ttyd-runtime.js`:**
  - `verifyRuntime` checks that the binary is executable, that its manifest records its sha256 and the digest matches, that its closure is clean, and that `--version` matches the manifest. Every failing check is reported.
  - `resolveTtydPath` is the one answer. It returns the managed runtime or throws `RuntimeUnavailableError` with the repair. Homebrew is used only under an explicit `TANGLECLAW_TTYD_RUNTIME=homebrew`, with `ROLLBACK_WARNING`, and any other value is refused.
  - `installRuntime` verifies the stage, copies to `ttyd.new`, re-verifies it in place, keeps the current runtime as `ttyd.prev` only if that verifies, renames the manifest and then the binary, and verifies again.
  - `rollbackRuntime` restores `ttyd.prev` and sets the replaced runtime aside. `runtimeStatus` reports both.
- **`scripts/ttyd-runtime.js`** provides `resolve` / `install --from` / `rollback` / `status`. `resolve` prints only the path on stdout and exits 3 with the repair.
- **`deploy/install.sh`:** `TTYD_PATH` comes from `ttyd-runtime.js resolve`, which exits before any plist is written; the Homebrew ttyd stays installed as the rollback target.
- **`scripts/ingress-cutover.js`:** it resolves through the same library (`which('ttyd')` is removed) and refuses with the new `ttyd-runtime-unavailable` code before its first write.
- **Docs:** the configuration reference (`TANGLECLAW_TTYD_RUNTIME` and the commands), the user guide, FEATURES and a CHANGELOG `Fixed` entry.

## 2026-09-26 — Owned ttyd runtime, part 1: pinned inputs, build entry point, closure verifier (#1245, chunk 05)

<!-- prawduct: type=feature | scope=ttyd-1245 -->

R24 / ADR 0018 §2–3.
- **`deploy/ttyd/inputs.json`** pins every input: the ttyd 1.7.7, libuv 1.52.1, json-c 0.19 and libwebsockets 4.5.2 tarballs, each digest matching Homebrew's pin; CMake 3.31.6's wheel; the two tracked patches (#1573 unmodified; A3c with its hunks identical to the accepted patch and only the headers normalized); the static build flags; and the allowed system roots.
- **`lib/macho-closure.js`** walks the complete Mach-O graph, resolving `@rpath`, `@loader_path` and `@executable_path`. It allows only `/usr/lib/` and `/System/Library/` or the private bundle, and refuses any `LC_RPATH` outside the bundle.
- **`scripts/build-ttyd.js`** is the deterministic entry point.
  - It verifies every download before extracting it; poisoned cache entries are deleted, and `--offline` is supported.
  - CMake comes from `pip --require-hashes` into a venv inside the work directory, and the build environment has no Homebrew on its PATH.
  - Dependencies are built statically, the libwebsockets config is rewritten to name only the static target, and each patch is re-verified right before it is applied.
  - The STAGED binary's closure is verified, and a provenance manifest is written. It never installs.

**Evidence.**
- A real build from the tracked inputs staged ttyd sha256 `dfae4e69…`, byte-identical to an independent earlier spike build, so the build is reproducible.
- `otool -L` lists only `/usr/lib/libz`, `libutil` and `libSystem`, with no `LC_RPATH`.
- The verifier passes the static binary and refuses both the Homebrew-linked A3c and the installed Homebrew ttyd, each on its five Homebrew dylibs.

## 2026-09-26 — Revert the A1 attach-script wrapper; adopt the owned ttyd runtime (#1245, R24)

<!-- prawduct: type=chore | scope=ttyd-1245 -->

Architect ruling R24, with ADR 0018 committed unchanged.
- **Why A1 is reverted:** it failed the R22 Q7 contract (6 wedges in 1500 cycles) and was rejected as the shipping fix.
- **What the revert restores:** `deploy/ttyd-attach.sh` and `test/ttyd-attach.test.js` are byte-identical to origin/main
  again, including the original "exec the attach" contract. The A1 claims in CHANGELOG, FEATURES and the user guide are
  removed.
- **What is kept:** the A1 evidence (`.tangleclaw/plans/1245-evidence/a1-acceptance-2e714fbc-FAIL.json`), its plan
  history and the change-log entries below.
- **Where the fix goes now:** the A3c source fix, delivered as a TangleClaw-owned, self-contained ttyd (chunks 05–07).

## 2026-09-25 — ttyd attach script drains on hang-up: the #1245 root fix candidate A1 (chunk 03)

<!-- prawduct: type=bugfix | scope=ttyd-1245 -->

**Root cause.** On close, ttyd pauses its pty reads and sends SIGHUP to the child's process group. The exec'd `tmux attach` was the session leader. On macOS a session leader's exit waits, with no timeout, for its terminal's output queue to drain, and ttyd never reads it again. The child stuck in `E` holding a PTY. The churn harness reproduced it: 60 of 60 stuck, while the no-output control stuck none.

**The change (`deploy/ttyd-attach.sh`).**
- The script stays the leader. The replay and the client run in the background under `wait`.
- A HUP/TERM/INT trap, set before the replay, SIGKILLs and reaps both, runs `tcflush(TCOFLUSH)` via `/usr/bin/perl` POSIX, and exits.

**Iteration history (scratch only).**
- Revision 1 put the replay in the foreground. In the `replay` close mode, 8 of 20 scripts stayed in `Ss+`, because bash defers a trap until a foreground command returns, and a replay blocked writing to an unread pty never does.
- Revision 2 backgrounds the replay.

**Evidence.**
- Revision 2: every close mode clean. A 100-cycle all-mode run had 0 wedges and 0 lingering, and the pool and fds returned to baseline.
- A traced 50-cycle run showed `hup > drain-enter > children-reaped > flushed-exit` for all 50, with hang-up to exit at a p50 of 24 ms and a maximum of 54 ms. ttyd reaped 50 of 50.
- **Race closed after review (observation O-3 of `rev-20260925T211252Z-51f4f2b6`).** A hang-up could land after `tmux attach … &` forked and before `client=$!`, so the trap would miss the client. The drain now kills `$(jobs -pr)`, meaning running jobs only, so a finished job's recycled PID is never signalled. It then waits for everything. Re-traced over 50 cycles: every close in order, hang-up to exit at a p50 of 28 ms and a max of 64 ms, and 50 of 50 reaped. The first acceptance run was stopped to test this revision instead; its interrupt cleanup left no scratch process.
- The full R22 Q7 acceptance run (2000 cycles plus a 2 h soak) is recorded separately.

**Test contracts changed (R22 Q1 required the old exec rationale to be covered):**
- "should exec the tmux attach command" was replaced by the drain contract:
  - no exec, the attach runs in the background under wait, and `0<&0`;
  - the replay runs in the background;
  - the trap is set before the replay;
  - the drain order is ignore signals, kill, reap, flush, exit;
  - perl is called by absolute path;
  - the drain also runs on the normal path.
- The "replay before attach" ordering test now anchors on `tmux attach-session`, not `exec tmux attach-session`.
- The "every terminal branch execs" contract still holds for the no-session `exec sleep 30`.
- Mutation checks: exec'ing the attach again, a foreground replay, and flushing before reaping are each caught.

## 2026-09-25 — ttyd wedge predicate per the Architect's R22 Q3 amendment (#1245)

<!-- prawduct: type=bugfix | scope=ttyd-1245 -->

The Architect amended R22 Q3 (21:05Z) after review R-1/R-5.
- **The etime route is gone.** A confirmed wedge is the same child PID seen E/Z in successful readings of one ttyd generation at least 30 s apart.
- **The record:** `advanceExiting` keeps it per generation and child PID, and is pure. A child a successful reading shows absent or not exiting is reset. A failed reading, or one without a generation, neither advances nor confirms; its orphan gate is `null`, not `false`.
- **Why the earlier cut was wrong:** it confirmed against *any* earlier qualifying reading. So a child that exited, went back to running and exited again was counted from its first exit.
- **Tests:** added for each guard (a reset on "not exiting", a reset on "absent", a failed reading, no generation, a moment short of the age).

## 2026-09-25 — ttyd churn harness and the baseline reproduction (#1245, chunk 01)

<!-- prawduct: type=feature | scope=ttyd-1245 -->

Pilot B1, #1245 chunk 01. The plan is `.tangleclaw/plans/1245-ttyd-child-leak.md`. Architect ruling R22 (Q1, Q6, Q7) governs it.

**Why.** R22 made the fix an evidence-gated choice: first reproduce the installed-build failure with a mutation-sensitive harness, then hold every candidate to the same contract.

**The change.**
- `lib/ttyd-churn.js`: the pure decisions, all tested.
  - Preflight: the live ttyd row must be clear, PTY use at most 15%, concurrency 1–10, and the binaries present.
  - Stop rules: 5 wedges, 25% PTY use, or a blind measurement.
  - The wedge floor (seen exiting for ≥ 10 s, measured by the sampler, never by process age).
  - Exiting-child lifetime tracking, and the verdicts (baseline `reproduced`; control `harness-fault`; candidate `pass` only on the full Q7 contract, otherwise `inconclusive`).
- `scripts/ttyd-churn.js`: the runner.
  - It uses a scratch ttyd on its own socket in `/tmp/tcc-<id>` (short on purpose: macOS limits a unix socket path to 104 bytes).
  - A tmux shim pins `-L tcc-<id>` and its own `TMUX_TMPDIR`.
  - Five close modes (clean, abrupt, paused, replay, noread) and a 250 ms sampler.
  - Cleanup is by exact PID and verified.
- `lib/ws-unix-client.js`: gains `path` and `protocol` options, with unchanged defaults. The test server exposes the request head.

**Evidence.** The live ttyd 28870 and live tmux server 1335 were unchanged after every run.
- Control (`exec cat`, 50 cycles): 0 wedges; the pool went 38 → 39 → 38.
- Baseline (installed 1.7.7_6 plus the shipped script): reproduced. First run, under the process-age measure (superseded): 47 of 50 stuck, pool 38 → 88. Re-run after review fix R-1 (observed-exiting measure plus a 30 s watch before the kill): all 60 of 60 children were still exiting ≥ 29.8 s after first being seen exiting, the pool went 41 → 102, the ttyd fds 32 → 213, and after cleanup the pool was back to 41. The control re-run was clean.
- The reports are in `.tangleclaw/plans/1245-evidence/`.
- The first attempt failed before starting anything, because its tmux socket path ran past the unix-socket limit. That led to the short `/tmp` default.

## 2026-09-25 — ttyd watcher: one shared reading, confirmed wedges, kickstart receipts (#1245, chunk 02)

<!-- prawduct: type=bugfix | scope=ttyd-1245 -->

Pilot B1, #1245 chunk 02. The plan is `.tangleclaw/plans/1245-ttyd-child-leak.md`. Architect ruling R22 (Q2–Q5) governs it.

**Root cause (of the disagreement, not of the leak).** The watcher, the health sampler and the UI cache each measured ttyd on their own. None of their readings was bound to a ttyd process. The watcher judged a single snapshot, in which a child that was merely exiting counted as leaked, and its synchronous probes turned a failed measurement into zero. So the panel could read 22/20 while a process read showed the five expected clients, and a restart the watcher did not make was invisible to it.

**The change.**
- **One reading:** a single async, single-flight `takeReading()` owns measurement. It records the pid, a generation (`<pid>@<lstart>`), the sample time, each child's state and age from one `ps` call, and the pool. A failed probe is `null`.
- **Sharing it:** the watcher tick classifies that exact reading, and `measureLeak` serves it to `lib/system-health.js`. History is per generation; a new generation drops the old readings.
- **Confirmed wedges:** a child counts when it is E/Z AND was seen E/Z in an earlier reading of the same generation at least `wedgeAgeMs` (30 s) before. (Superseded: the first cut also confirmed on process age ≥ 120 s. Review R-1/R-5 showed that `ps etime` is process age, not time exiting, so that route was removed.) Transients are reported apart from wedges.
- **Receipts:** after a kickstart the watcher re-reads, bounded at 10 s, until a new generation appears, and records `ok` / `no-new-generation` / `failed`. A generation change it did not cause is `external-restart`, and no actor is named.
- **Ticks:** they never overlap, and one runs at boot.
- **Switches:** `TANGLECLAW_TTYD_WATCHER` and `TANGLECLAW_TTYD_ORPHAN_THRESHOLD` (5–200). Invalid values warn and use the safe default. When the watcher is disabled, health reports `unknown`.
- **Health:** the ttyd condition carries `reading {pid, generation, sampledAt}` and `lastReceipt`. A cached reading of a replaced ttyd is dropped and re-measured.

**Review.** The Critic cumulative review `rev-20260925T204343Z-b1361aa6` found 0 blocking.
- **R-1, fixed:** a kickstart triggered on a reading with no readable start time could call the SAME ttyd a new one, and log its own restart as external. The proof of a restart now needs a different pid when the start time was missing, and the external suppression is keyed by pid.
- **R-2 and R-3, fixed:** plan Status and design notes.
- **R-4, accepted:** a slow respawn logs both lines.

**Test contracts changed (approved by R22; none weakened silently):**
- **Synchronous probes and `_check`:** the sync probes (`_getTtydPid`, `_isPtyPoolExhausted`, `_countTtydOrphans`, `_countTtydZombies`, `_ttydUptimeMs`) and the sync `_check` were removed (R22 Q2: no sync fail-safe zero). Their tests were ported to `_parsePid`, `_poolFromCounts`, `_parseChildren`, `classifyReading`, `takeReading` and `_tick`.
- **The pool's failure value:** the pool "fail-safe `{cap: 0}`" contract became "`null`, never an empty pool".
- **The 15-minute uptime hold:** retired (R22 Q3), together with its five watcher tests and four health tests. Its purpose, not tripping on a restart's reconnect burst, is now pinned by the burst tests (a young burst does not kickstart; the same children on a later tick do; an earlier sighting under a different generation confirms nothing). Its sub-contracts carried forward: the pool gate never held, a refused kickstart staying armed, and an unreadable age not suppressing (it now confirms on the second sighting).
- **The zombie-count diagnostic:** dropped. The child list now carries every state.
- **Real-host smoke tests:** these now run the parsers against real `ps` and `sysctl` output.

**Verification.** Mutation checks (each break was caught, then reverted):
- removing the observation gap;
- counting every E/Z child as wedged;
- acting on an unknown gate;
- letting a disabled watcher read as clear;
- serving a replaced ttyd's cached reading.

The declared suite result is recorded by `prawduct-hook test-evidence`.

## 2026-09-25 — Medusa delivery watchdog: tracked exchanges, durable re-arms, escalation (#1839)

<!-- prawduct: type=feature | scope=medusa-1839 -->

Dual Builder Normalization Train, Chunk B, Car B1 (TangleClaw-Pilot-B2). The plan is `.tangleclaw/plans/1839-medusa-delivery-watchdog.md`. Architect rulings R19, R20, `e2956328` (unverified readers), A3 (`a06a43ac`, approved as corrected `1b6f3ca4`) are recorded there. The work was built in five chunks.

**Root cause.** "Sent" meant "the Hub stored it". Nothing owned whether a message reached its reader. The wake ledger recorded nudges only, so #1435's hand-read mail stayed listed forever and #1621's lost Enter was silent. A blocked sender waited until someone noticed a badge.

**The change.**
- **Schema v49 (additive):**
  - `medusa_exchanges` is a projection;
  - `medusa_exchange_facts` is append-only, enforced by triggers;
  - both are keyed by the Hub message id, and no body is stored.
- **Sending:**
  - the intent is recorded before the Hub is called, then the Hub id is bound;
  - a lost answer is `send_unknown`, never re-sent;
  - a reused `requestId` is refused;
  - an arrival that beats the answer is adopted, by Hub id only (verified against the Hub source).
- **Priority and proof:**
  - blocking needs a verified launch and critical needs the operator;
  - reply, close and retract need verified callers;
  - protected priorities off-host are refused.
- **Recipient facts:**
  - reads and acks are scoped to the reader's workspace and name their actor (`recipient`, `operator-ui`, `unverified-reader`);
  - a reply-required exchange is satisfied only by a reply;
  - `retracted` is a guarded terminal state (route: #1873).
- **Wakes (`lib/wake-transports.js`):**
  - each nudge carries a nonce;
  - tmux gives negative receipts only;
  - owned edges are watched observe-only;
  - after a restart the monitor consults the durable attempts before nudging.
- **The watchdog (`lib/medusa-watchdog.js`):**
  - re-arms only on a negative receipt or a persisted post-attempt readiness change, never on time, with a persisted budget;
  - climbs a one-way ladder: aged (sender), escalated (the `authority.escalation` route on the control assignment), operator (dashboard banner and activity row);
  - records every notice as queued, then accepted or failed.
- **Teardown** retires the workspace, so waiting exchanges end as `recipient_retired` and their initiators are told.
- **Surfaces:**
  - routes: `…/medusa/exchanges`, `…/exchanges/:id/close`, `/api/medusa/escalations`, `/api/server-info` `medusaEscalations`;
  - `tc message send --priority …`, `tc message sent`, `tc message close`;
  - the `medusaWatchdog` config;
  - docs: `docs/medusa-delivery.md`, plus one guide line.

**Tests.**
- New: `test/medusa-exchanges.test.js`, `test/api-medusa-exchanges.test.js`, `test/medusa-watchdog.test.js`, `test/medusa-escalation.test.js`, `test/store-medusa-exchange-migration.test.js`, and the isolated exit test `test/medusa-watchdog-e2e.test.js`.
- The existing wake tests pass unmodified. The full suite is green on the final tree.

**Reviews.** Every chunk boundary had a Critic round. All blocking findings were fixed and verified, among them a restart duplicate wake, a forged-ack path and a reconnect-stranded re-arm.

Fixes #1839, #1435. Refs #1873, #1806, #1621, #1879.

## 2026-09-25 — Wrap advice knows what upstream already holds (#1868)

<!-- prawduct: type=bugfix | scope=wrap-1868 -->

Dual Builder Pilot, Car A2 (TangleClaw-Pilot-B1). The plan is `.tangleclaw/plans/1868-wrap-upstream-provenance.md`. Architect rulings R11, R13 (controlling) and R14 are recorded there.

**Root cause.** Wrap advice was a function of file kind (`_file-safety.js` `durable` → Include), and no wrap step read a remote ref. So a session checkout left behind after its worktree PR merged was offered its own merged plan, and a carrier byte-identical to upstream, as work to commit.

**The change.**
- **`lib/wrap-steps/_upstream-provenance.js`:**
  - resolves the default branch (`<remote>/HEAD`, else `main`/`master`);
  - makes one bounded refresh in `session-files`, which honors the behind-origin opt-outs;
  - records the commit the ref names;
  - judges each dirty path from git content: `already-upstream`, `upstream-owns`, `unverified` or `none`. The exception for the branch's own work is proven from HEAD vs the merge-base, and never applies to an untracked path.
- **`classify` precedence:** methodology > TC state > protected DB > provenance > TC maintenance > ownership > file kind (the secret scan still runs after classify).
  - Exact matches go to a non-interactive `alreadyUpstream` bucket.
  - `upstream-owns` is asked, with Keep local recommended.
  - Unverified evidence never recommends Include.
- **Commit rechecks** against the captured commit, and against the current ref if it moved, with no network. It only tightens. An Include whose echoed `pathDecisionBasis` is weaker than the current verdict is asked again (`provenanceChanged`), and the drawer prunes it.
- **The drawer** shows the provenance headline, the "Already upstream" manifest group and the per-path copy.
- **R15 local drawer smoke** (scratch instance, headless Chrome) found raw fetch stderr duplicated in the row copy, and that it was unredacted. The refresh reason is now redacted with `redactRemoteOutput` and shortened, it is shown once in the headline, and stale rows get a short sentence. The redaction test was seen to fail with redaction disabled.
- **changelog-coverage** reuses session-files' verdicts, which was accepted in the Critic disposition.

**Tests.** New `test/wrap-upstream-provenance.test.js`, which runs real bare-origin fleets. It covers:
- the exact B2 incident;
- an exact match, whether owned, maintenance or foreign;
- an untracked path with richer upstream content;
- a genuinely new plan;
- unavailable, stale and no-remote upstream;
- `trunk` on a remote named `upstream`, a detached HEAD, and a linked worktree;
- an R11-E ref move before commit;
- the R14 revert and both-sides cases, with negative controls;
- deletions;
- precedence;
- the changelog predicate path;
- no mutation.

The drawer and wiring tests are extended. Pinned shapes gained the new fields, and nothing was relaxed. The full suite is green at the reviewed head.

**Critic.** Cumulative `rev-20260925T161734Z-32402ac3` found 1 blocking issue: the changelog predicate path was untested. It is fixed and verified. The table break is fixed, and diverged paths are surfaced. Two items were accepted: the secret scan does not run on already-upstream files, and changelog-coverage replays verdicts. Verify-resolutions `rev-20260925T163746Z-f610b722` returned 0 findings.

## 2026-09-25 — HOLD and STOP are durable and refuse TangleClaw's own mutations before anyone reads them (#1861)

<!-- prawduct: type=feature | scope=control-state-1861 -->

Dual Builder Normalization Train, Chunk A, Car A1 (TangleClaw-Pilot-B2). Chunks 01–06 of `.tangleclaw/plans/1861-durable-control-state.md`. Architect rulings R1 (A1–A9), R2 (N1–N5), R3 (B/C) and R4-B are recorded in the plan, and the incident ruling I1 is recorded below.

**The change.** Schema v48 adds four tables. `control_assignments` and `control_holds` are caches. `control_events` and `control_receipts` are append-only, enforced by triggers. `lib/control-state.js` holds the rules:
- server-assigned generations, separate from receipt order;
- cumulative named holds, released by compare-and-set on the expected generation, with per-issuer authority and explicit delegation;
- STOP is terminal, and only an operator successor supersedes it atomically;
- close is allowed only for an active assignment with no holds;
- a `notify_pending` receipt is written in the same transaction as each event.

The API and CLI: `/api/control/*` and `tc control` (`lib/control-auth.js` for the operator proof tier, `lib/control-api.js`). `lib/control-gate.js#checkMutation` reads the tables directly before every TangleClaw-owned side effect:
- every wrap boundary, and inside the commit step before release-prepare, branch, commit, push, PR create and auto-merge arming;
- `pr-merge`, the stranded-wrap PR, command injection, actions and the startup prompt;
- restart and update-apply, gated on the caller;
- launch into a stopped lane.

A wrap is checked against the assignment it was admitted under. `lib/control-hooks.js` adds managed pre-commit and pre-push hooks as defense in depth: they chain a foreign hook transactionally, and a tracked hooks path is left UNPROTECTED. Docs: `docs/control-state.md`, plus a "Held or stopped?" line in every engine's guide.

**Tests.** New: `control-state`, `store-control-migration`, `control-auth`, `api-control`, `control-gate`, `control-surfaces`, `control-hooks` (real repos, a stub API in a child process), `control-docs`, `tc-control`, and `control-e2e`. The e2e test is the exit condition: a HOLD whose notice is queued and unread refuses the wrap, and nothing is committed. Contract updates, none of them weakening:
- the runner and wake option sets include the new server-owned keys, with typeof assertions;
- the prime-golden fixtures gain the `control` verb (a word diff shows only that);
- `startup-prompt-store` compares against `CURRENT_SCHEMA_VERSION`;
- `api-update-apply` runs over a scratch store, because the route consults the gate.

Mutation checks: removing each new guard or branch fails its test. One R-4 test first passed with the fix removed; it was rewritten to reproduce the real launch order.

**Critic.** The cumulative review (`rev-20260925T143036Z-2bc1c66c`) found 2 blocking, 7 warnings and 6 notes:
- **Blocking:** the notice-handled observation was dropped, and three plan-mandated tests were missing.
- **Fixed:** R-2 through R-9, R-12 and R-13.
- **Accepted:** R-10, R-11, R-14 and R-15.

The first verify-resolutions ran before the fixes were committed and saw none of them. The second confirmed all 10, and raised one blocking finding: three new branches were untested. That was fixed in `01ac724d`, and the third pass found nothing. Four observations were accepted.

**Incident I1.** An early run of `control-e2e` wrote a hook marker naming `localhost:3102`, because the pane exports `TANGLECLAW_PORT=3102` and that outranks the config. A scratch-repo commit then sent the live server one read-only `GET /api/control/check`, which answered 404. Nothing was written and nothing was restarted. The test now removes `TANGLECLAW_PORT` and asserts that the marker names its own instance, and every boundary suite ran with all `TANGLECLAW_*` variables unset.

**R4-B, applied after the draft PR opened.** When control state cannot be established, restart and update-apply refuse every caller, the operator included, with `503 CONTROL_STATE_UNAVAILABLE`. That covers an unprimed governed memory and an unreadable store. A verified operator passes a readable HOLD, never an unreadable store. The ruling reached the inbox during the Critic runs and was seen only after #1866 opened. It was fixed in `b7a163f8`, which has a verify-resolutions pass with no findings and a PR re-review with 0 blocking.

**Honest limit.** Shell `git`/`gh` is not server-enforceable. The managed hooks narrow the gap, and the docs list every bypass.

## 2026-09-25 — A wrap never commits a SQLite database, and it recommends safe answers (#1858)

<!-- prawduct: type=bugfix | scope=wrap-file-safety-1858 -->
Chunks 01–03 of `.tangleclaw/plans/1858-wrap-file-safety.md`. The new `_file-safety.js` gives each file one of four classes: protected, local, durable or ambiguous. `classify` withholds protected files (SQLite by header, extension or sidecar) from every bucket, so neither `session-files` nor `commit` will stage one, whatever Include arrives. Ignored Includes are recorded. Other files carry an advisory recommendation, and no answer is preset. Both steps emit a manifest by path, and `session-files` emits exact ignore lines. `changelog-coverage` no longer counts a withheld database as work. The drawer shows each recommendation, a projected manifest before a new Apply-recommendations-and-retry button, the withheld databases with no choice, and the manifest on settled rows. It also prunes remembered answers for withheld databases. The Architect ruled on A1–A8 on 2026-09-25 (A8, a handback refusal, was rejected and is not built). The cumulative review caught one blocking bug: Apply could fill Include for a new plan that also matched a secret rule. The fix is that a secret-flagged file is never recommended for Include, on the server or in the drawer. The wrap API reference (`docs/configuration-reference.md`) now documents the new outputs.

## 2026-09-25 — `launch-rule-drift` tests import `node:assert/strict` (Pilot 4)

<!-- prawduct: type=chore | scope=strict-assert-launch-rule-drift -->
`test/launch-rule-drift.test.js` switched from `node:assert` to `node:assert/strict`, as the testing-conventions norm requires. Every assertion already called a strict method, so no test's accepted behaviour changes. Substituted for TST-5N8W, whose conversion shipped in #1378. Three suites still import non-strict `node:assert` (remote-output, wrap-consecutive-step-delivery, wrap-delivery-receipt) — tracked against #1377.

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
