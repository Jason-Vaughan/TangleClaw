---
branch: fix/1245-ttyd-child-leak
partition: investigation used 2 delegated read-only scouts (Architect requirement), shared worktree, no writes. Build partition is proposed per chunk below and waits for the Architect's ruling
---

# #1245: ttyd child leak, permanent fix

*Pilot B1. The PM dispatched this on 2026-09-25 for INVESTIGATION + PLAN WRITTEN ONLY. Planned on `main` @49a55381.
Evidence comes from two disjoint read-only scouts: (1) upstream / Homebrew / isolated churn comparison, and
(2) the local watcher / health / cache / process-state contract. Their key citations were spot-checked by the planner.*

## Status

- [x] Investigation: 2 read-only scouts collected and spot-checked (2026-09-25)
- [x] Plan written (rev 1)
- [x] Architect ruled on Q1–Q7 (R22, 2026-09-25): all approved, Q1/Q5/Q6/Q7 with modifications. See "Architect ruling R22"
- [x] Plan revised with R22 (rev 2)
- [x] ~~HELD while B2 was the sole #1839 writer.~~ **Released by the PM on 2026-09-25 at 20:30Z**: #1839 was merged,
      live-synced and wrapped, and B1 is the sole writer. B1's collision revalidation passed. #1839 touched none of the
      #1245 surfaces; its `server.js` boot-block lines only sit beside `ttydWatcher.start()`. The PM confirmed it at
      20:31Z. The branch was rebased onto origin/main 310dfbc3
- [x] Chunk 01: mutation-sensitive churn harness under the R22 host guards; fail-fast baseline reproduction against
      the installed 1.7.7_6 plus mutation proof. Harness at 44906acf. Results (re-run after review) are in "Chunk 01
      results" below. T_age is set to 30 s of observed exiting, pending the Architect's ruling on the R-1/R-5 predicate change
- [x] Chunk 02: bounded async single-flight `takeReading()`, PID/generation binding, confirmed-wedge predicate,
      action receipt, immediate boot check, env kill switch and bounded threshold. Committed at fd22adf9. The Critic
      cumulative review `rev-20260925T204343Z-b1361aa6` found 0 blocking. R-1 (a receipt on a reading with no
      generation) is fixed with tests. R-2 (this Status) and the design notes are fixed. The slow-restart note is accepted
- [x] Chunk 03: candidate matrix (A1+A2 and A3) against the same acceptance contract; the winner is chosen by evidence.
      **A3c PASSED** the full R22 Q7 acceptance (see "A3 build and matrix"). STOPPED at the packaging boundary.
      A1 (8c483c60, 2e714fbc) FAILED the R22 Q7 acceptance on 2e714fbc: 6 confirmed ?Es wedges in 1500 cycles (~0.4%,
      against 100% at baseline). Report: `.tangleclaw/plans/1245-evidence/a1-acceptance-2e714fbc-FAIL.json`. The Architect's
      R22 Q1 fallback ruling (21:24Z) REJECTS A1 as the shipping fix: keep its evidence, and plan to revert or exclude the
      wrapper from the final tree. A3 is APPROVED: a build-only patched ttyd in scratch (see "A3 build" below)
- [x] R24 recorded; A1 reverted from the product tree (the attach script and its tests are byte-identical to origin/main;
      the doc/CHANGELOG claims are removed; the evidence is kept)
- [x] Chunk 05: owned runtime, part 1. Pinned inputs and patches (`deploy/ttyd/`), the deterministic build/package entry
      point (`scripts/build-ttyd.js`), and the recursive Mach-O closure verifier. Focused tests, no network in tests.
      A real build staged sha256 `dfae4e69…`, byte-identical to the independent spike (reproducible), with a system-only closure
- [x] Chunk 06: owned runtime, part 2. The shared resolver plus transactional install/rollback (`lib/ttyd-runtime.js`),
      consumed by `install.sh` and `scripts/ingress-cutover.js`. Fails closed and names the repair. Homebrew only as an
      explicit rollback, with a warning. `scripts/ttyd-runtime.js` is the CLI; the docs and CHANGELOG are updated
- [x] Chunk 07: build the packaged artifact from tracked inputs, verify its closure, then the full R22 acceptance on
      that exact artifact (2000 cycles plus a 2 h soak). Record its digest and load graph.
      **Run 6 PASSED** (2026-09-26 05:48:38Z–07:56Z, harness 626280ec, review rev-20260926T054745Z-39931d6e, artifact
      dfae4e69…). See "Chunk 07 packaged acceptance". Runs 1 and 5 are supporting evidence (each failed only on a harness
      measurement defect); runs 2–4 were stopped to meet the Architect's harness conditions. Awaiting the Architect's
      chunk 07 disposition
- [x] **Chunk 08 (R24.9 / ADR 0018 §4) — REQUIRED IN THIS PR before merge-readiness review (Architect R34, 2026-09-26 08:07Z).**
      No interim manual-provisioning contract, and ADR 0018 is not weakened or rewritten. Dispatch: PM-managed, in a FRESH
      context. It must deliver:
      (1) managed `install.sh` provisions the runtime itself (build to a temp stage via build-ttyd.js, install, resolve)
          when it is absent, invalid or stale, before any plist write; it skips only a verified runtime whose manifest
          `inputsJsonSha256` matches the current `deploy/ttyd/inputs.json`;
      (2) whole-input currency: the resolver compares `inputsJsonSha256` (Critic R-4) and refuses a stale runtime; the
          cutover never builds, it refuses and points to `install.sh`;
      (3) fault-injection tests at every copy/rename boundary of install and rollback; the docs state the exact
          fail-closed, recoverable guarantee;
      (4) `ttyd-runtime.js status` and the cutover result report which runtime was selected;
      (5) rollback docs after a pin change (the last known good no longer verifies; `TANGLECLAW_TTYD_RUNTIME=homebrew`
          is the way back).
      Also, in the SAME resolution batch (review rev-20260926T080127Z-ee1da76f):
      - R-7: move the CHANGELOG harness line out of #1858's `### Fixed` entry into `### Internal`;
      - R-8: keep the cause of every failed harness probe (readPool/readProcTable/readFds/which), as the watcher's
        `reading.errors` does;
      - R-5: one shared E/Z predicate (export the watcher's `_isExiting`);
      - R-6: strip ruling/chunk ids from shipped code comments and state the rule itself;
      - R-2: `git add -f` the gitignored scratch ttyd logs the evidence cites (run6/run5/acceptance-dfae4e69/a3c).
      R-1 stays OPEN until this lands. Then run the full suite and a NEW cumulative Critic after chunks 08 and 04.
      **BUILT (2026-09-26, dispatched by the PM 14:37Z in a fresh context).** All five deliverables and the carried batch
      are in the chunk 08 commit: `provision` in `lib/ttyd-runtime.js`/`scripts/ttyd-runtime.js`, called by
      `deploy/install.sh`; whole-file currency via `inputsJsonSha256` (a stale runtime is refused, and so is a stale last
      known good at rollback); install and rollback staged beside the current pair and promoted manifest-first, with
      rollback COPYING the last known good; fault-injection tests at every copy/chmod/rename boundary; `status.selected`
      and the cutover's `ttydRuntime`; the docs. R-7, R-8, R-5, R-6 and R-2 are in the same commit. The box is ticked
      after the cumulative Critic (see R35). **Reviewed and accepted 2026-09-26:** cumulative
      rev-20260926T150050Z-6620a07c, then (after the R39 rewrite) rev-20260926T151846Z-e094065e and verify-resolutions
      rev-20260926T152837Z-80909b30 and rev-20260926T153732Z-7d87805f. 0 blocking; branch coverage is composed with no
      unresolved blocking. Fixes are at ede42d18 and 7c1bf135; the suite is green at 7c1bf135.
- [x] Chunk 04 (revised): rollout and rollback docs for the owned runtime (F/G, the user guide, the configuration
      reference), and the CHANGELOG. Re-tuning the watcher waits for live certification. **In the SAME dispatch and PR
      as chunk 08 (Architect R35).**
      **BUILT (2026-09-26).** Two Operator runbooks, `docs/runbooks/roll-out-the-owned-ttyd.md` and
      `docs/runbooks/roll-back-the-owned-ttyd.md`, with the R36/R37 permission checkpoint before the restart; F and G
      above revised to match; links from the configuration reference, the user guide and FEATURES; the CHANGELOG entry.
      The runbooks are not validated until the Operator executes them. Reviewed with chunk 08 (see above); R40 added the
      rebuild/rollback permission checkpoint and the live access check.
- [ ] Verify (the full suite), the cumulative Critic, one draft PR ONLY when the PM authorizes (pilot boundary: no merge).
      The PR body says `Refs #1245`, NOT `Fixes #1245`: the issue stays open until live certification (review
      rev-20260926T150050Z-6620a07c R-11).
      #1245 stays open until post-merge live certification. D3 (upstream offer) is prepared separately and not submitted
      without authorization

**Pilot envelope (IN FORCE):** no merging any PR, no pulling or updating the live checkout, no restarting the
live service, no tests on the main instance, no tag, publish or release, no deploy. Everything below that runs
a ttyd runs an *isolated* one: its own unix socket, its own `tmux -L` server, a scratch directory outside
`~/Documents`.

## Architect rulings R41 and R42 (2026-09-26 15:40Z; controlling)

- **R41 (ADR 0018 §4):** correct §4 before merge. Its "rerun the installer" instruction is wrong for caddy mode. The
  ADR now states the implemented `SELECT_BY_MODE` contract: on an absent, invalid or stale managed runtime, the
  refusal directs the operator first to `node scripts/ttyd-runtime.js provision`, then to `deploy/install.sh` (direct
  mode) or `node scripts/ingress-cutover.js --to caddy` (caddy mode). This is a narrow normative-document correction;
  the PM and B1 own the edit. *Done 2026-09-26.*
- **R42 (backup ref):** once the rewritten head and the clean verification receipt are durably recorded (they are:
  this plan and `.prawduct/change-log.md` record head 7c1bf135 and verify-resolutions rev-20260926T153732Z-7d87805f),
  delete the local-only `backup/1245-pre-r39-redaction` ref before any push. It served its recovery purpose and must
  never be pushed. No object-store purge is required. *Done 2026-09-26: the ref is deleted, and no local ref still
  contains the pre-rewrite commits.*

## Architect rulings R39 and R40 (2026-09-26 15:08Z, on cumulative review rev-20260926T150050Z-6620a07c; controlling)

- **R39 (Critic R-8, evidence privacy):** the local history rewrite before any push is APPROVED. The run5
  `pre-cleanup.txt` and `post-cleanup.txt` snapshots carried an unrelated process's (`agy`) open-file table: the host's
  LAN and public IPv6 addresses and that tool's oauth-token and conversation paths. Every commit containing them is
  rewritten so those lines carry a stable redaction marker, and the whole range intended for push is validated clean.
  No pre-rewrite commit or ref is ever pushed. *Done 2026-09-26:* the NAME field of all 105 `agy` lsof lines in each
  file was replaced. Only the 5 commits from 626280ec onward changed, and no hash or reference pinned either file. A
  scan of all 32 commits after 310dfbc3 (trees, added lines, messages) found none of the values. The pre-rewrite head
  is kept ONLY as the local ref `backup/1245-pre-r39-redaction`, which must never be pushed.
- **R40 (Critic R-7, macOS permissions):** "first switch only" is not a supportable promise. The parity checkpoint
  applies on the initial switch AND after every rebuilt or replaced executable whose hash or signing identity changed
  (rollback included), unless a stable signing requirement is later established and verified. It observes and proves
  parity; it never authorizes broader grants (R37). Record the artifact's sha256 and signing identity and the observed
  grants, run the live access check, and STOP on denial or ambiguity. Never claim that macOS keeps a grant across a
  rebuild.
- Also: resolve the other warnings and the R-3 wording, run the suite after the rewrite, then ONE verification review
  over the rewritten, complete candidate before merge-readiness.

## Architect ruling R37 (2026-09-26 14:52Z; SECURITY CORRECTION, controlling over R36's Full Disk Access sentence)

R36 called Full Disk Access a documented minimum. That sentence is superseded; the rest of R36 stands.

- The shipped ttyd plist's #500 contract says ttyd is intentionally DENIED Full Disk Access, and the attach script lives
  outside `~/Documents` so that ttyd does not need it. That comment stays unless evidence proves it stale.
- Least privilege controls. The Operator inspects the old ttyd path and gives `~/.tangleclaw/bin/ttyd` exact visible
  parity, which means NO Full Disk Access when the old path has none. Never add Full Disk Access merely because projects
  live under `~/Documents`.
- If parity cannot be established, or a required live check fails, STOP and report. Any broader grant is a separate,
  explicit Operator risk decision.
- The checkpoint stays before the restart, and the exact grants observed stay as rollout evidence.

## Architect ruling R36 (2026-09-26 14:50Z, relayed by the PM at 14:50Z; controlling for chunk 04's rollout runbook)

The macOS permission (TCC) step of the first switch to `~/.tangleclaw/bin/ttyd`:

- Do not invent or claim an exact, complete grant set from repo evidence.
- ~~The documented minimum for this host's projects under `~/Documents` is **Full Disk Access**, keyed to ttyd's absolute
  executable path.~~ **Superseded by R37: exact visible parity, and no Full Disk Access unless the old path has it.** The
  old Homebrew ttyd path may hold resource-specific grants that the repo cannot enumerate.
- The runbook makes this an explicit **Operator-present GUI checkpoint**: inspect the old ttyd entry, give
  `~/.tangleclaw/bin/ttyd` the same visible grants (exact parity, per R37), then restart ttyd and verify in the real
  launchd context.
- The exact grants observed are **rollout evidence**, not pre-merge proof. No Builder performs this live step.

## Architect ruling R35 (2026-09-26 14:39Z, relayed by the PM and confirmed by the Architect at 14:45Z; controlling)

The chunk 08 dispatch is amended to include chunk 04 in the same context and the same PR boundary. Sequence:

1. Complete and commit chunk 08 and the carried findings (R-1, R-2, R-4, R-5, R-6, R-7, R-8).
2. Complete and commit chunk 04: the rollout docs, the user guide, the configuration reference and the CHANGELOG.
3. Run the full suite ONCE, over the combined candidate.
4. Run ONE new cumulative Critic over chunks 08 and 04 and all prior work.

There is no merge-readiness checkpoint after chunk 08 alone. This ruling had to be recorded here before any work
past chunk 08; it lands in the chunk 08 commit.

## Architect ruling R22 (2026-09-25 18:48Z, controlling; where it differs from the sections below, R22 wins)

- **Q1: an evidence-gated candidate matrix, not a preselected fix.** First reproduce the installed-build failure with
  a mutation-sensitive harness. Test A1+A2 and A3 (the Darwin master-side flush) against the same acceptance contract.
  A1 may win only if the harness proves its HUP/trap/wait ordering flushes *before* the session leader enters
  `ttywait`. The added wrapper process and the earlier `exec` rationale must be covered. Reducing replay (A2) alone is
  mitigation, never completion. If A1 is flaky or cannot guarantee ordering, **A3 is the preferred root fix** (it acts at
  the PTY master close boundary, matching the upterm evidence). A3 may be *built* only after implementation release.
  Installing it, changing the plist or TCC, or touching live stays with the Operator/PM.
- **Q2: approved.** One bounded async single-flight `takeReading()` owns measurement. The watcher evaluates the
  exact returned reading, and health serves that reading's PID, generation and sample timestamp. There is no
  synchronous fail-safe zero: a measurement failure is null/unknown and never triggers action. Overlapping ticks are
  prevented, and old-generation cache entries are discarded.
- **Q3: approved.** Confirmed wedge = E/Z AND (age ≥ T_age OR K = 2 observations of the same child in the same ttyd
  generation). T_age is derived from baseline data. Transient E/Z is recorded separately from confirmed wedges. The
  15-minute orphan hold is retired only once this predicate is in place. The pool gate stays immediate and independent.
- **Q4: approved.** A bounded post-kickstart re-read must prove a new PID/generation and persist `ok` /
  `no-new-generation` / `failed`. A generation change with no action receipt is `external-restart`. Never attribute
  an actor that cannot be proven.
- **Q5: approved with safety.** Env kill switch plus a bounded threshold override. Disabled or invalid configuration
  is logged loudly, and health says disabled/unknown, never clear. The threshold is bounded to a documented safe range,
  and invalid input falls back to the safe default.
- **Q6: approved with host guards.**
  - Isolation: an isolated unix socket, a unique `tmux -L` name, a scratch directory, exact-PID cleanup traps, and no
    live ttyd, tmux or service mutation.
  - Preflight: live health clear and ample PTY headroom.
  - While running: concurrency capped at **10**; sample the global pool and scratch descendants between batches.
  - Fail fast at **5 confirmed scratch wedges or 25 % global PTY use**. On stop, kill only the scratch ttyd and verify
    PTY and fd counts return to baseline. If cleanup cannot restore them, stop and report.
  - No 2 000-cycle failing baseline once reproduction is established.
- **Q7: approved as modified.**
  - **Baseline:** fail-fast reproduction plus mutation proof.
  - **Each shippable candidate:** 2 000 guarded cycles and a 2-hour isolated soak, with zero confirmed wedges, zero
    restarts, and resources back to baseline.
  - **Post-merge live certification:** at least 72 h **and** a recorded, meaningful attach/detach sample, with zero
    orphan kickstarts, zero persistent E/Z and no upward PTY trend. Extend the period if it is too quiet.
  - #1245 stays open until certification.
- **Staging: one PR** unless new evidence forces a split. Chunks 01–02 are completed and validated first on the
  branch. They do **not** deploy separately (section F is revised to match).
- **Hold:** the plan is approved, but implementation stays held while B2 is the sole #1839 writer (see Status).

## Architect ruling R24 (2026-09-26 00:40Z, controlling; the durable record is `docs/adr/0018-owned-ttyd-runtime.md`)

- **D1 approved with modifications.** A TangleClaw-owned runtime at `~/.tangleclaw/bin/ttyd`, self-contained at process
  start: its full Mach-O load graph may reference only its private bundle plus macOS system roots, with no Homebrew,
  MacPorts, temp or Cellar dependency.
- **Automatic fallback rejected.** A missing or unloadable managed runtime fails before the plist or live service changes
  and names the repair. `/opt/homebrew/bin/ttyd` is an explicit Operator rollback only, with a warning that the fix is no
  longer active. A last-known-good managed runtime is kept, and installation is transactional.
- **D2 rejected** (a local tap moves the Cellar path). **D3 approved in parallel, non-blocking:** prepare the upstream
  offer, but submit nothing external without PM/Operator authorization.
- **A1 reverted** from the final tree, with its tests and every doc/CHANGELOG claim. Its failure artifacts and plan
  history are kept.
- **One product PR:**
  - pinned inputs, patches and digests;
  - a deterministic build/package entry point;
  - a recursive Mach-O verifier;
  - one shared ttyd-path resolver for `install.sh` and ingress-cutover;
  - transactional install and rollback;
  - the watcher/health work and the harness;
  - corrected docs and CHANGELOG;
  - ADR 0018, committed unchanged.
- **The packaged self-contained binary must itself pass the full R22 contract.** The Homebrew-linked `fe6c…`
  acceptance selects the source fix, not the package.
- **Sequence:** revise the plan; revert A1; package with focused tests; verify the closure; mutation/control as needed;
  the full acceptance on the exact packaged artifact; the cumulative Critic; one draft PR when the PM authorizes. STOP
  before install, plist, TCC, restart, merge or upstream submission.

**Feasibility, checked before any product code (scratch spike).** A static build of ttyd 1.7.7 + #1573 + A3c was made
against static libwebsockets 4.5.2 (no TLS, libuv built in, unix sockets, IPv6, HTTP/2), libuv 1.52.1 and json-c 0.19,
every tarball matching Homebrew's pinned digest. It loads only `/usr/lib/libz.1.dylib`, `/usr/lib/libutil.dylib` and
`/usr/lib/libSystem.B.dylib`, with no `LC_RPATH`. So a self-contained closure is achievable and no escalation is needed.
libwebsockets' installed CMake config names the shared target as well, so the build rewrites it to name only
`websockets`.

## A3 build and matrix (2026-09-25; the Architect approved A3c at 21:34Z, controlling)

Evidence, patches and provenance: `.tangleclaw/plans/1245-evidence/a3/` (`provenance.json` pins everything below).
Every run used the ORIGINAL pre-A1 attach script (`origin/main:deploy/ttyd-attach.sh`), isolated under the R22 Q6 guards.
The live ttyd 28870 and live tmux 1335 were verified unchanged after every run.

**Provenance.**
- CMake 3.31.6 from a disposable venv in scratch; the wheel sha256 is recorded.
- ttyd 1.7.7 tarball sha256 `039dd995…`, which is Homebrew's formula pin.
- #1573 at head `82a15573`.
- Apple clang 17.0.0.
- Built against Homebrew's libwebsockets 4.5.2, json-c 0.19, libuv 1.52.1 and openssl 3.6.2, read-only. `otool -L`
  matches the installed 1.7.7_6.
- No brew change, no `pip --user`, no install.

| # | Build | Result | Meaning |
|---|---|---|---|
| 1 | 1.7.7 + #1573, no fix (control) | **reproduced**: 37/60 stuck `?Es`, PTY 45→83 | #1573 alone does not fix it |
| 2 | + one-shot master `TIOCFLUSH(FWRITE)` after `pty_pause`, before `pty_kill` | **failed**: 51/60 stuck, PTY 45→97 | Rejected. The child (the tmux client) writes its teardown output AFTER the hang-up, which refills the queue the leader then waits on. A flush before the kill cannot precede writes made after it |
| 3 | **A3c**: + drain after close (Darwin-gated, `src/protocol.c`) | **clean**, 200 prelim cycles: 0 stuck, 0 lingering, 200/200 reaped | Approved (21:34Z) |
| M1 | A3c without the close-time `pty_resume` | **reproduced**: 11 stuck by 100 cycles | The close-time resume is necessary |
| M2 | A3c without the per-chunk `pty_resume` | **reproduced**: 55 stuck by 60 cycles | The per-chunk resume is necessary |
| S | A3c built with ASan + UBSan, 400 cycles | **clean**: 0 sanitizer reports, 0 restarts, 400/400 reaped | No callback-lifetime, double-free or use-after-free defect seen |

**A3c rationale.** In ttyd 1.7.7, `paused` is set true at spawn and never cleared, so `pty_pause()` is a no-op.
`read_cb` stops the stream after every chunk, and only a writable websocket restarts it (`pty_resume`). After a close,
`process_read_cb` discards the next chunk (`ws_closed`) and never restarts reading, so the child's output queue is
never read again. On Darwin a session leader's exit waits for that queue to drain, and that is the deadlock.

A3c keeps reading after the close and discards until end of file:
- in the `ws_closed` read path, free each non-null chunk exactly once and `pty_resume`; a null buffer (EOF or a read
  error) does not resume;
- at `LWS_CALLBACK_CLOSED`, `pty_resume` (after `ws_closed` is set) replaces the no-op `pty_pause`;
- `ctx->pss` is never dereferenced after the close, and child exit keeps ownership of teardown.

It is gated to `__APPLE__`, which leaves other platforms byte-for-byte unchanged. The Darwin binary is identical to the
preliminary A3c (`fe6c1813…`). Generic upstreaming can be proposed separately.

**Full acceptance (R22 Q7): PASS** on the release build `fe6c1813…`, with the original attach script. It ran from 21:40Z
to 23:47Z (`a3c-acceptance-PASS.json`, and the scratch ttyd's own log in `a3c-acceptance-ttyd.log`).
- **Churn:** 2000 of 2000 cycles across all five close modes, 1600 of them with output and 0 client errors. The full
  120-minute soak was completed.
- **Children:** 0 confirmed wedges and 0 lingering. The scratch ttyd started 2000 processes and reaped 2000. At most 10
  children existed at once, and in the whole run the sampler saw only one child in the exiting state, gone by the next sample.
- **Resources:** the scratch ttyd's fds went 32 → 33 and there were 0 restarts. Cleanup was verified with no leftovers.
- **Pool caveat, stated honestly:** the global PTY pool went 45 → peak 50 → 27 at the end. The drop is NOT this run's
  doing. At 23:39:47Z the LIVE watcher, still running main's code, kickstarted the live ttyd (pid 28870 → 10597) on
  `orphans=23` after 5.2 h of real use: the unfixed production leak recurring on its own. That freed live PTYs, so
  "pool returned to baseline" is confounded for this run. The run-specific evidence (2000/2000 reaped, 0 lingering, fds
  back to baseline) does not depend on the pool.
- **Live processes:** the live tmux server 1335 was unchanged. The harness only ever addresses its own scratch socket
  and PIDs.

**STOP: the packaging/rollout boundary (R22 Q1).** The delivery options, and the revert of the rejected A1 wrapper,
wait for the Architect and the PM.

## Chunk 07 packaged acceptance (the terminal record)

**Run 6: PASS** on the exact packaged artifact.
- Start 2026-09-26T05:48:38.509Z, end ~07:56Z.
- Harness `626280ec156516f40425703033616230c3fd8977` (clean), cleared by `rev-20260926T054745Z-39931d6e`.
- Artifact sha256 `dfae4e69a9d07c026c5f99360670fc2c7607986ddc1916338e15ad46d5ba6cea`, self-contained: it loads only
  `/usr/lib/libz.1.dylib`, `/usr/lib/libutil.dylib` and `/usr/lib/libSystem.B.dylib`.
- Report sha256 `703e38ef3bafb7cd2a74c260876bea699a70d5ed1a7445e069694d1ff7e71e62`.
- Original pre-A1 attach script.

| Gate | Value |
|---|---|
| Cycles and modes | 2000/2000; clean, abrupt, paused, replay, noread; 1600 with output; 0 client errors |
| Soak | 7,200,000 ms (the full 120 min); stop = completed |
| Confirmed wedges / lingering / restarts | 0 / 0 / 0 (max 10 children at once) |
| Run-owned PTYs | baseline {0 slaves, 0 masters} → final {0, 0} |
| Scratch ttyd fds | 16 → 17 (within tolerance) |
| Reaping | the scratch ttyd started 2000 and reaped 2000 |
| Cleanup | ok: 0 survivors (1968 PIDs and 1660 groups recorded by identity); post-cleanup snapshot "no run-owned process by identity" |
| Global pool (diagnostic) | 43 → 58 → 33. The drop is the LIVE watcher kickstarting the live, unfixed ttyd at 06:09:52Z on 27 orphans from real use (pid 10597 → 7826), not this run |

Evidence: `.tangleclaw/plans/1245-evidence/packaged/run6/` (the report, the scratch ttyd log, the baseline, pre-cleanup
and post-cleanup snapshots). The harness never touched the live ttyd or tmux.

**Run history.**
- Run 1: clean on run-owned evidence, but failed on the global pool (the live leak).
- Runs 2–4: stopped to meet the Architect's harness conditions (the cut-off lsof reading, PID reuse, lsof exit 1, the E/Z bounds).
- Run 5: every product gate passed, but it failed on a harness false positive (the shared process group). Kept as
  supporting evidence and not relabelled (R27).
- Run 6: PASS.

## Architect R22 Q1 fallback ruling (2026-09-25 21:24Z, controlling)

- **A1 is rejected** as the shipping root fix. 6 wedges in 1500 cycles fail the zero-defect contract; spend no more runs
  on shell timing. Keep its evidence, and plan to revert or exclude the A1 wrapper from the final tree unless a later
  ruling keeps a narrowly proven mitigation.
- **A3 is approved, with isolation rules:**
  - **Toolchain:** CMake from a disposable Python venv inside the harness scratch directory, pinned, with its version
    and artifact digest recorded. No `pip --user`, no `brew install`, no Homebrew changes. Homebrew's existing headers
    and libraries may be read.
  - **Provenance to pin and record:** the ttyd 1.7.7 source, the #1573 revision, the Darwin flush patch, the compiler,
    the link inputs and the `otool -L` output.
- **Candidate matrix,** both run with the ORIGINAL pre-A1 attach script:
  - (1) 1.7.7 + #1573 with NO flush. This is the mutation/control and must reproduce.
  - (2) the same build plus a Darwin master-side `TIOCFLUSH(FWRITE)` at the close boundary, before child teardown can
    enter the drain deadlock. This is A3.
- **Order:** a guarded preliminary reproduction first. Only the patched candidate goes on to 2000 cycles and the 2 h soak.
- **Boundary:** no live install, stable-path copy, plist/TCC edit, service test, sync or restart. If A3 passes, STOP at the
  packaging and rollout boundary and report: the patch, source and build provenance, the mutation result, the acceptance
  evidence, and the delivery options, all before changing the PR's shape.

## Architect ruling R22 Q3 amendment (2026-09-25 21:05Z, controlling; supersedes the Q3 bullet above)

- **The `ps etime ≥ T_age` route is dropped entirely.** Process lifetime is not exit-state age, and using it is unsafe for
  old tabs caught during an ordinary exit. `etime` may stay on a reading as a diagnostic, and must never trigger
  recycling.
- **Confirmed wedge:** the same child PID observed in E/Z in two qualifying, successful readings of the same ttyd
  PID/generation, with at least 30 s between the first and the confirming observation.
- **History:** keyed by ttyd generation plus child PID.
  - A child's history resets when a successful reading shows it absent or outside E/Z.
  - All history is discarded on a generation change.
  - A failed or unknown reading may neither advance nor confirm the predicate.
- **Where it is implemented:** `advanceExiting` / `classifyReading` in `lib/ttyd-watcher.js`, with tests for each guard
  and for the long-lived-tab mutant.
- **Evidence:** the corrected control and baseline evidence, and the 30 s observed-exit persistence, are accepted,
  subject to verify-resolutions.
- **A1:** it failed candidate acceptance (3 of 50 children unreaped, not E/Z). The close mode must be isolated, and A1
  either fixed so every child exits and resources return to baseline, or rejected in favour of build-only A3.

## What the operator required (the 2026-09-25 escalation) and where each is answered

| Requirement | Section |
|---|---|
| Distinguish transient E/Z reconnect bursts from persistent wedged children (child age or consecutive observations) | B |
| Detection, action and cache share one PID- and generation-bound reading, with an action receipt | C |
| Immediate bounded watcher check at server startup | D |
| Test updated ttyd / current upstream against the installed build under repeatable websocket churn | A, E |
| Root fix or replacement transport, plus rollback | A, G |
| Acceptance: churn/soak with no unbounded child growth and no periodic restart treadmill; the watcher stays only a safety net | E |

## Findings

### Upstream and Homebrew: an upgrade will not fix it (confidence: high)

- Installed ttyd is 1.7.7 at formula revision `1.7.7_6`. Homebrew offers `_12`. Revisions `_7`–`_12` are rebuilds
  against newer libwebsockets (4.5.3 → 5.0.0) from the same 1.7.7 tarball, with no patches.
- Upstream `tsl0922/ttyd`: 1.7.7 (2024-03-30) is still the latest release. Main is 24 commits ahead and none
  touch the pty close/reap path. The nearest is `ae1dd49ad8`, which only affects `--once` / `--exit-no-conn`
  (unused here). Open PR [#1573](https://github.com/tsl0922/ttyd/pull/1573) fixes a related read stall
  after a zero-byte read, not the close path. [#1401](https://github.com/tsl0922/ttyd/issues/1401) was
  closed as "your command should clean its child process".
- The live binary loads libwebsockets through `/opt/homebrew/opt/...`. A libwebsockets-only upgrade
  would therefore change the live ttyd **without** moving its Cellar path. A general `brew upgrade` moves both.

### Likely mechanism: a macOS exit-drain deadlock (INFERRED from source, matches every observation)

1. On websocket close, ttyd 1.7.7 stops reading the pty (`pty_pause`) and sends SIGHUP to the child's
   process group. It closes the pty master only in `process_free`, after its `waitpid` thread returns.
2. On Darwin, an exiting session leader calls `ttywait()`, which waits with **no timeout** for the tty's output
   queue to drain (`bsd/kern/kern_exit.c`, `bsd/kern/tty.c`). Our `tmux attach` *is* the session leader,
   because ttyd `setsid`s and `deploy/ttyd-attach.sh:44` `exec`s tmux.
3. If output is still queued at close, the child waits for ttyd to read, and ttyd waits for the child to exit.
   The child sits in `E`, SIGKILL cannot move it, and only ttyd dying frees it.
4. Our attach replays up to 10 000 lines of scrollback into the pty on every connect (`deploy/ttyd-attach.sh:43`),
   which is exactly what fills that queue during reconnect churn.

This matches the leak growing with churn and on busy panes, children that cannot be killed, and a kickstart
that clears them. The same deadlock was just fixed in upterm by flushing from the master with
`TIOCFLUSH`/`FWRITE` ([owenthereal/upterm#589](https://github.com/owenthereal/upterm/pull/589), merged 2026-09-25).
**Unproven until chunk 01's baseline reproduces it.**

### Local contract: the three readers disagree by construction (VERIFIED, file:line)

- **Detection** (`lib/ttyd-watcher.js:210-255`): a single `ps -A -o ppid=,stat=` snapshot per tick. A
  child is leaked if its `stat` contains `E` or `Z`. The gate fires at ≥ 20. There is no per-child age and no
  consecutive-observation memory. The only time input is ttyd's own uptime (the 15-minute hold, `:31`, `:505`).
- **Watcher** (`_check`, `:448`): synchronous, every 5 min (`:567`). It stores nothing, its return value has
  no production caller, and `_kickstartTtyd` returns true on `launchctl` exit 0 without checking that the PID
  changed (`:359`). There is no receipt.
- **Health sampler** (`measureLeak`, `:283`, via `lib/system-health.js:156`): an async twin of the same
  probes with a 60 s stale-while-revalidate cache (`system-health.js:125`, `:200-212`). The payload's
  `checkedAt` is the *request* time, not the reading's (`:452`). The watcher never invalidates it after a
  kickstart. The health transition log records "fired" sets, never "cleared" counts (`:447`).
- **UI** (`public/landing.js:1164`, `:2438`): 60 s poll, keeps its last render on fetch failure.
- **Boot**: `server.js:11280` starts the watcher with no immediate tick, so the first check comes 5 min after
  boot, while `systemHealth.warm()` (`:11283`) fires at once. On 09-25, six server restarts each reset that wait.
- **Nothing is bound to a ttyd PID or generation**, and there is no kill switch (`_disabled` only flips in
  `_reset`) and no env knob (`start()` options only; `server.js` passes none).

### Live evidence (read-only, 2026-09-25 18:40–18:44Z)

- ttyd PID 28870 started 18:28:54Z; binary `/opt/homebrew/Cellar/ttyd/1.7.7_6/bin/ttyd`.
- Three samples 60 s apart: six `Ss+` `tmux attach-session` children, 0 in E/Z, PTY use 31–32/511. This matches
  `tmux list-clients` and the health route (clear).
- The retained logs (09-24 17:28Z onward) show six kickstarts, all `reason=orphan-children` at 20–22, with
  35 min to 9.5 h between them. No warning cleared on its own: every "cleared" follows a kickstart or restart.
- **The escalation's "22/20, then clear with no restart" most likely had a restart after all.** ttyd was
  restarted at 18:28:54Z with no `[ttyd-watcher]` line. The panel had fired at 18:25:07 from a `warm()`
  reading of the pre-restart ttyd, and cleared at 18:30:00. The "five expected children" were the
  post-restart attaches (their elapsed time equals ttyd's). It was the PM's authorized `POST /api/server/restart` during the Car A2 live
  deployment (R23; see the end of this plan). That the watcher cannot see or record restarts it did not make is
  itself a finding (see C).

## Chunk 01 results (2026-09-25, isolated; the live ttyd 28870 and live tmux server 1335 were verified unchanged after every run)

Reports: `.tangleclaw/plans/1245-evidence/control-50.json`, `.tangleclaw/plans/1245-evidence/baseline-60.json`. These are the
re-runs after review fixes R-1/R-5 and R-9: wedges are counted by time SEEN exiting (the sampler's first sighting, never
`ps etime`), and a reproduced run is watched for 30 s before ttyd is killed. Preflight was clear each time, at about 41/511.

| Run | Child | Cycles | Wedged (seen exiting ≥ 10 s) | Left after every client closed | PTY used (base, peak, after cleanup) | ttyd fds (base, end) | Verdict |
|---|---|---|---|---|---|---|---|
| control | `exec cat` (writes nothing) | 50 | 0 | 0 | 41, 42, 41 | 32, 33 | **pass** (the harness invents no wedges) |
| baseline | installed ttyd 1.7.7_6 + shipped `ttyd-attach.sh` | 60 (stopped at the wedge limit, then watched 30 s) | **60** | 60, all `?Es`, each seen exiting ≥ 29.8 s | 41, **102**, 41 | 32, **213** | **reproduced** |

**What this establishes:**
- Under this churn the installed build leaves every connection's `tmux attach` child stuck exiting. Each one holds a PTY
  and about three fds, and none exited in the 30 s it was watched.
- Killing only the scratch ttyd frees all of them, and the pool returned to baseline.
- The only difference between the two runs is whether the child writes output. That is the evidence for the exit-drain
  mechanism: output still queued at close is what wedges the child.
- It also shows the harness is mutation-sensitive at the system level: it separates a wedging child from a clean one with
  the same ttyd, socket and clients.

**T_age (R22 Q3):** in both runs a clean exit finishes inside one 250 ms sample, and a wedged child is still exiting 30 s
later. The watcher's `wedgeAgeMs` is therefore set to **30 s of observed exiting** between two readings of the same
generation. The Architect must rule on this: the review showed that process age cannot stand in for time spent exiting
(R-1/R-5), so the "age OR second sighting" predicate became "second sighting at least 30 s apart".

**Not yet shown:** why the live install wedges only some connections, not all. Likely factors: real tabs close with less
queued output, and a 5-minute tick samples far less often. Chunk 03's candidates are measured under this worst-case load,
which is stricter than live.

## Chunk 02 design (the shared reading, wedge predicate, receipt, boot check, knobs)

Everything lives in `lib/ttyd-watcher.js`: it already owns the probes, and a separate module would split one
single-flight across two files. `lib/system-health.js` becomes a consumer.

**Reading** (`takeReading()`, async, single-flight, bounded per spawn; see Bound below):
`{ pid, generation, sampledAt, children: [{pid, stat, ageMs}], pool: {used, cap, ratio, exhausted}|null, error }`.
- `pid` comes from `launchctl list <label>`. `null` means ttyd isn't running, and nothing else is measured.
- `generation` is `<pid>@<lstart>` (`ps -o lstart= -p <pid>`). It's an identity, not a number, so nothing is
  parsed. If it can't be read it is `null`, and a reading with no generation can confirm nothing through the K rule.
- `children` come from one `ps -A -o pid=,ppid=,stat=,etime=` call, keeping the rows whose ppid is ttyd's pid.
  `ageMs` is `null` when `etime` doesn't parse.
- A probe that fails leaves its field `null`. It is never set to zero.

**History**: the module keeps a small ring of readings. A reading from a different generation clears the ring, so
old-generation entries are dropped (R22 Q2).

**Classification** (`classifyReading(reading, previous, opts)`, pure):
- `transient`: children in E/Z that are not confirmed.
- `wedged`: children in E/Z where `ageMs ≥ wedgeAgeMs`, OR the same child pid was in E/Z in an earlier reading of
  the same generation taken at least `wedgeAgeMs` (30 s) before (K = 2). The gap is needed because the
  health panel and the watcher tick share the reading store: without it, two readings a second apart would confirm a
  one-second-old child.
- *(Revised after review R-1/R-5.)* The first cut ALSO confirmed any E/Z child whose `ps etime` was at least 120 s.
  etime is how long a process has existed, not how long it has been exiting, so that route would have tripped the gate
  on hours-old tabs closing together. It was removed. Confirmation is only a second sighting at least `wedgeAgeMs` = 30 s
  later, a value set from chunk 01's data (see "Chunk 01 results").
- `orphanGate = wedged.length ≥ orphanThreshold`. `poolGate = pool.exhausted`. Both are independent, and the pool gate
  is never held.
- If `children` is `null` (ps failed), the orphan gate is `null`/unknown and never acts (R22 Q2: no fail-safe zero).
- The 15-minute uptime hold is retired. A restart burst's children are young and unconfirmed, and they're confirmed
  on the next tick only if they're still there.

**Bound**: each spawn is limited to `SHELL_TIMEOUT_MS` (5 s). `launchctl` runs first and the rest run in parallel, so one
reading is bounded by about three spawns (~15 s). There is no separate overall deadline.

**Tick** (`_tick()`, async; `_tickInFlight` prevents overlapping ticks):
1. `takeReading()`. If `pid` is `null`, the action is `skipped`.
2. If the generation changed and there's no pending receipt for that change, record a receipt with outcome
   `external-restart`. The receipt names no actor.
3. Classify. Pool gate or orphan gate → kickstart → `_awaitNewGeneration()` re-reads with a bounded poll → receipt
   `{at, reason, from:{pid,generation}, to:{pid,generation}|null, outcome: ok|no-new-generation|failed}`,
   logged at warn. A refused kickstart (`failed`) leaves the gate armed for the next tick.
4. Return `{action, reading, classification, receipt}`. This is still a test seam, but the health module now
   consumes the reading, so it has a real consumer.

**Boot**: `start()` runs one tick right away, off the event loop and unref'd, and it can't block boot because
the tick is async. Every probe is bounded. Then the normal interval runs.

**Knobs**:
- `TANGLECLAW_TTYD_WATCHER=off` → the watcher does not act, and logs a warn once at `start()`. Health reports the
  condition `unknown` with "watcher disabled".
- `TANGLECLAW_TTYD_ORPHAN_THRESHOLD`: an integer in [5, 200]. Anything else falls back to 20, with a loud warn at
  start. Health quotes the threshold in force.
- `start()` options still override for tests.

**Health** (revised: `system-health.js` keeps its non-awaiting 60 s cache and its `measureLeak` probe seam, and
`measureLeak` becomes the adapter over the shared reading): `detectTtydLeak` serves `ttydWatcher.latestReading()` together with its classification. When the reading
is older than the TTL, it starts `takeReading()` (the same single-flight) and never awaits it. The payload carries the
reading's `sampledAt`, `pid` and `generation`, the last receipt, and whether the watcher is disabled. `measureLeak`
stays, as the adapter that classifies the shared reading for health.

**Tests** (each existing behaviour is ported to the new API, not dropped):
- pool boundary cases → `_poolFromCounts` / reading
- E/Z counting → classification
- kickstart argv, the uid guard and refusal → unchanged
- the pool gate is never held on a young ttyd → tick
- a refused kickstart stays armed → tick
- unreadable age: not confirmed by age, but confirmed by K = 2 on the next tick
- non-darwin makes no calls → unchanged
- `measureLeak`'s "null, not zero" contract → the reading's null fields

New tests:
- a young E/Z burst is transient, not wedged
- an old E/Z child is wedged
- K = 2 with the same generation confirms; a generation change resets it
- receipt outcomes: ok, no-new-generation, failed, external-restart
- overlapping ticks are refused
- the boot tick runs immediately
- the env kill switch and threshold bounds, including invalid input
- health serves the reading's own sampledAt, pid and generation
- health reports disabled and ps-failure as unknown, never clear

## Chunk 01 design: the guarded churn harness (R22 Q1, Q6, Q7)

**Files**
- `scripts/ttyd-churn.js`: the CLI. It is never run by the suite and never touches the live service.
- `lib/ttyd-churn.js`: the pure, testable parts (guards, classification, lifetimes, verdict).
- `test/ttyd-churn.test.js`: tests for the pure parts, including mutation-sensitivity checks.
- `lib/ws-unix-client.js`: gains `path` and `protocols` options. Both are additive, and the defaults are unchanged
  (`/`, none).

**Isolation (Q6)**
- The scratch directory is `<scratchpad>/churn-<runId>/`, outside `~/Documents`, so no TCC grant is needed.
- The scratch ttyd runs as `<ttyd-bin> --writable --url-arg --interface <scratch>/ttyd.sock --port 0 <scratch>/attach.sh`.
  - Its env is `PATH=<scratch>/bin:$PATH` plus `TMUX_TMPDIR=<scratch>/tmux`, with `TMUX` unset.
  - `<scratch>/bin/tmux` is a shim: `exec <real tmux> -L tc-churn-<runId> "$@"`.
  - The tmux socket is therefore both uniquely named and in a scratch directory. The live tmux server cannot be addressed.
- `attach.sh` is a copy of the script under test (`--attach-script`, default `deploy/ttyd-attach.sh`) run unmodified.
  The shim is what isolates it.
- The tmux session is `churn`, running an output generator (default: a loop printing numbered lines every 20 ms). It
  starts with pre-seeded scrollback, so the attach script's 10k-line replay has something to replay.
- Cleanup is by exact PID only. It records the scratch ttyd's pid and its tmux server's pid, then:
  - sends SIGTERM, waits, sends SIGKILL, and never uses `pkill`/`killall`;
  - runs `tmux -L <name> kill-server`;
  - verifies that no process with the scratch ttyd as parent remains.

**Preflight (Q6), refusing to start unless all of these hold:**
- `GET $TANGLECLAW_API/api/system/health` shows the `ttyd-leak` row `clear`;
- global PTY use is ≤ 15% of `kern.tty.ptmx_max`, which leaves headroom below the 25% stop line;
- the scratch socket path is unused;
- the ttyd and tmux binaries resolve;
- the platform is darwin.

**Run**
- Batches of at most **10** concurrent clients (a hard cap; asking for more is refused).
- Each client does the following:
  1. dial the unix socket: path `/ws?arg=churn`, subprotocol `tty`;
  2. send `{"AuthToken":"","columns":120,"rows":40}`;
  3. wait for the mode's trigger;
  4. close by mode:
     - `clean`: close with 1000 after the first output;
     - `abrupt`: `socket.destroy()` after the first output (a killed tab);
     - `paused`: send `2`, then destroy;
     - `replay`: destroy on the first byte, while scrollback is still streaming;
     - `noread`: pause the socket, never read, and destroy after 2 s.
- **Sampler:** every 250 ms, one `ps -A -o pid=,ppid=,stat=,etime=`, filtered to the scratch ttyd's children. It
  tracks each exiting child's first- and last-seen time, which gives the E/Z lifetime distribution used to derive
  T_age (Q3).
- **Between batches:**
  - the global pool (sysctl plus `ls /dev/ttys*`);
  - the scratch ttyd's fd count (`lsof -p <pid>`) and RSS;
  - scratch wedges, using the watcher's own predicate (`classifyReading`) against a harness history, plus a
    harness-side age floor.
- **Fail fast** at ≥ 5 confirmed scratch wedges or ≥ 25% global PTY use. It stops, cleans up and reports
  `reproduced` (wedges) or `aborted-pool`.
- **Baseline mode** stops as soon as reproduction is established; it never runs 2000 failing cycles.

**Verdict and report** (JSON, written to the scratch directory; a summary goes to stdout)
- The run records `{cycles, modes, maxChildren, confirmedWedges, transientLifetimesMs: {p50, p95, p99, max}, pool
  {baseline, peak, final}, fds {baseline, peak, final}, restarts: 0, cleanup: {ok, leftovers}}`.
- **Pass (Q7)**, for each shippable candidate:
  - 2000 cycles across all modes, then a 2 h soak;
  - zero confirmed wedges and zero restarts;
  - PTY and fd counts back to baseline (± tolerance) within 30 s of quiescence.

**Mutation sensitivity**
- The pure verdict and guard functions are unit-tested with fixtures in which a wedge must be found, and must not be
  found for a transient child.
- **The control run** uses a known-good command (`--control`: the scratch ttyd runs `cat` instead of `attach.sh`),
  which must show zero wedges.
- **The baseline run** uses the installed ttyd and the shipped script, which must reproduce.
- A harness that reports "pass" for the baseline, or "fail" for the control, is itself broken.

## A. Root fix options

| # | Option | Changes | TCC impact | Rollback | Planner view |
|---|---|---|---|---|---|
| A1 | **Script-side drain.** `ttyd-attach.sh` stops `exec`ing tmux. The script stays session leader, and on HUP it kills tmux, waits, flushes its own output queue from the slave side (`tcflush(0, TCOFLUSH)`, no root needed) and exits | ~20 lines of shell (or a tiny helper), reversing the "exec to leave one child" choice | None | `git revert` of one script | **Recommended first.** Cheapest, no binary change. Must be proven by the harness, because it adds a process per connection and its correctness depends on the mechanism |
| A2 | **Also cut the scrollback-replay queue.** Replay via a path that doesn't sit in the pty output queue at close, or bound its size | Script change only | None | Revert | Complements A1. It also shrinks the exposure window if A1 is imperfect |
| A3 | **Locally patched ttyd at a stable path** (`~/.tangleclaw/bin/ttyd`): 1.7.7 + #1573 + a master-side `TIOCFLUSH` before the kill (or keep reading and discard after close) | Owned build (needs `cmake`, not installed); the plist points at the new path | One-time re-grant for the new path. Afterwards, brew upgrades no longer move the grant | Point the plist back at `/opt/homebrew/bin/ttyd` | Use if A1 fails the harness. Offer the patch upstream |
| A4 | Replacement transport (TangleClaw serves the pty itself; tmux control mode) | Large rewrite; node-pty conflicts with the no-dependency stance | Varies | Feature flag back to ttyd | Not recommended now. Gotty and wetty share the same pty drain hazard |
| — | Brew upgrade to `_12` / upstream main | Dependency rebuild only | Moves the Cellar path and loses the grant | — | Tested in the harness for completeness, **not** proposed as the fix |

## B. Persistent vs transient: detection criterion

*(Superseded by R-1/R-5: see chunk 02's design. Process age is not used.)* A child counts as **wedged** only if it is in `E`/`Z`, **and** (its own `etime` ≥ T_age, proposed 120 s, **or** the
same child PID was seen in E/Z on K consecutive readings of the same ttyd generation, proposed K = 2). The gate
counts wedged children only. A reconnect burst of young E children can no longer trip it; a real wedge still
does within one or two ticks. The 15-minute ttyd-uptime hold becomes redundant for the orphan gate and is
proposed for retirement (Q3). The pool-ratio gate is unchanged and never held.

The harness (E) measures the real E-state lifetime distribution under churn, so T_age is set from data, not
guessed.

## C. One shared reading, bound to PID and generation, with an action receipt

- New `lib/ttyd-reading.js` (or a section of `ttyd-watcher.js`): `takeReading()` (async, bounded) returns
  `{pid, generation: ttyd lstart, sampledAt, children: [{pid, stat, etimeS}], pool: {used, max}}` and keeps a
  short ring of recent readings. It is the only probe; both `_check` and `measureLeak` are rewritten on top of it.
- The watcher tick consumes the latest reading. The health route serves that reading (with its own
  `sampledAt`, PID and generation) instead of measuring on its own, so the panel and the watchdog can no
  longer disagree about the same instant.
- **Action receipt** `{at, reason, from: {pid, generation}, to: {pid, generation}, outcome}`: after a kickstart,
  the watcher re-reads until a new generation appears (bounded), records `ok` / `no-new-generation` /
  `failed`, logs it, and exposes the last receipt in the health payload. Readings from an older generation are
  dropped from the ring.
- **Unobserved restarts**: a generation change with no receipt is recorded as `external-restart` (it would have
  explained today's 18:28:54 event).

## D. Immediate boot check

`start()` schedules one async, bounded `takeReading()` + evaluate right away (timer unref'd, overall deadline ~10 s,
never blocking boot), then the normal interval. The panel's first "fired" and the watcher's first decision then come
from the same reading.

## E. Harness and soak acceptance

- **Harness** (chunk 01, test tooling only, runs only against an isolated ttyd): extends `lib/ws-unix-client.js`
  with `Sec-WebSocket-Protocol: tty` and the `{"AuthToken":"","columns","rows"}` first frame, plus `?arg=` for
  `--url-arg`. Close modes: clean 1000, abrupt destroy (tab kill), close while paused (`2`), close during
  scrollback replay or heavy output, and a connection held open while never reading.
- **Isolation**: ttyd on its own unix socket in the scratchpad, `tmux -L churn` from a scratch directory outside
  `~/Documents` with output generators. No PortHub port and no TCC needed. N ≤ 50 concurrent, because the pty pool
  (511) is shared with the live service.
- **Matrix**: installed 1.7.7_6 (baseline, expected to reproduce the wedge in close-during-output), then A1(+A2),
  and optionally A3 and upstream main built into a scratch prefix.
- **Pass** (per candidate): ≥ 2 000 open/close cycles across every close mode, then a 2 h soak, with:
  - children ≤ open clients + burst tolerance;
  - no E/Z child older than 10 s;
  - PTY and fd counts back to baseline within 30 s of quiescence;
  - zero restarts.
- **Live acceptance after rollout** (the operator's): 72 h of normal use with zero `reason=orphan-children`
  kickstarts. The watcher stays armed throughout as the safety net.

## F. Rollout (revised for R24 / ADR 0018 §4 and R36/R37; the attach-script route was rejected with A1)

What ships: the chunk 02 watcher/health work, and the A3c source fix delivered as a TangleClaw-owned, self-contained
ttyd at `~/.tangleclaw/bin/ttyd`, built from tracked, pinned inputs. The Operator procedure is
`docs/runbooks/roll-out-the-owned-ttyd.md`; this section is its outline.

1. **One PR,** opened only when the PM says so. B1 does not merge.
2. **Provision (Operator/PM, on the host):** `node scripts/ttyd-runtime.js provision` builds from the pinned inputs into a
   temporary stage (every digest verified before use, the complete Mach-O load graph checked) and installs the result
   fail-closed and recoverably, keeping the previous runtime as last known good. It changes no plist and restarts
   nothing. It skips the build when the installed runtime already verifies and is current.
3. **Permission checkpoint, first switch only (Operator present, R36/R37):** the new path gets exactly the macOS grants
   the old ttyd path visibly holds, nothing more (no Full Disk Access unless the old path has it). The observed grants
   are rollout evidence. If parity cannot be established, stop.
4. **Select it (Operator/PM):** direct mode runs `./deploy/install.sh`; caddy mode runs
   `node scripts/ingress-cutover.js --to caddy` (never install.sh, which rewrites the plist for direct mode). Both get
   the ttyd path from the one shared resolver, write it into the plist and restart ttyd.
5. **Verify right after:**
   - the plist's program path is `~/.tangleclaw/bin/ttyd`;
   - `otool -L` on it lists only `/usr/lib` and `/System/Library`;
   - it is the running ttyd;
   - open and close a few tabs, then check that `ps` shows no `E` or `Z` children under ttyd.
6. **Live certification:** at least 72 h **and** a recorded, meaningful attach/detach sample, with zero orphan
   kickstarts, zero persistent E/Z and no upward PTY trend. #1245 stays open until then.
7. **Only after certification:** relax the watcher to a pure safety net, as a separate small change that the PM files.

## G. Rollback

The Operator procedure is `docs/runbooks/roll-back-the-owned-ttyd.md`.

- **Back to the last-known-good managed runtime:** `node scripts/ttyd-runtime.js rollback`, then restart ttyd
  (Operator/PM). It refuses a last known good built from a different `deploy/ttyd/inputs.json`.
- **Back to Homebrew ttyd:** an explicit Operator action, `TANGLECLAW_TTYD_RUNTIME=homebrew` on install.sh (direct) or
  the cutover (caddy). It regenerates the plist for the Homebrew ttyd and says plainly that the leak fix is no longer
  active and the watcher is again the mitigation. It is never automatic, and it is the only way back after a pin change.
- **The watcher/health work:** `TANGLECLAW_TTYD_WATCHER=off` / `TANGLECLAW_TTYD_ORPHAN_THRESHOLD` in the server plist,
  or a code revert.
- Homebrew's ttyd and its existing TCC grant are never modified by any of this.

## Tests: contracts that stay green and tests to add

- **Must stay green** (`test/ttyd-watcher.test.js`): E/Z counting and fail-safe to 0 (`:240-285`), the
  pool gate never held (`:411`), a refused kickstart leaves the gate armed (`:430`), an unreadable uptime
  does not suppress (`:449`), `measureLeak` returns null not 0 (`:843`, `:856`), no runner calls off darwin
  (`:759`). Also `test/system-health.test.js`: unknown before the first reading (`:100`), the route never
  awaits a measurement (`:109`, `:576`), TTL single-flight (`:218`), keeps the last good reading (`:238`); and
  `test/health-panel.test.js` `:57`, `:132`.
- **Contracts this plan would change, needing the Architect's ruling (Q2, Q3):** `_check` synchronous →
  async; the minimum-age hold (`:464`, `:476`) retired for the orphan gate.
- **New:** persistence by age and by K consecutive readings; a reading dropped on a PID/generation change;
  receipt outcomes, including `no-new-generation` and `external-restart`; the boot check runs immediately and is
  bounded; the payload carries the reading's `sampledAt`/PID/generation; and the harness pass/fail runner.

## Proposed partition (for the build, after rulings)

Chunk 01 (harness) and chunk 02 (reading/receipt) are disjoint, so they could be delegated in isolated worktrees.
Chunk 03 depends on 01's baseline. Proposed: 01 ∥ 02 delegated, 03 and 04 serial, all on one branch and one PR (R22).

## Questions for the Architect (answered by R22 above; kept for the record)

1. **Root fix path**: approve A1 (+A2) script-side drain as the first candidate, with A3 (patched ttyd at
   `~/.tangleclaw/bin/ttyd`, one TCC re-grant, a `cmake` install) as the fallback if A1 fails the harness?
2. **Single reading**: move detection entirely to one async `takeReading()` shared by the watcher and health
   route, retiring the synchronous fail-safe-0 `_check` contract, with the route serving the watcher's reading?
3. **Persistence criterion**: E/Z **and** (child age ≥ T_age **or** K = 2 consecutive same-generation readings),
   T_age set from harness data; retire the 15-minute ttyd-uptime hold for the orphan gate?
4. **Receipt promise**: re-read to a new generation (bounded) after each kickstart, and record
   `external-restart` for generation changes the watcher did not cause?
5. **Kill switch and env knobs**: add `TANGLECLAW_TTYD_WATCHER` and `TANGLECLAW_TTYD_ORPHAN_THRESHOLD`?
6. **Harness scope**: may chunk 01 run an isolated ttyd + `tmux -L` on this host (scratch socket, N ≤ 50,
   sharing the pty pool with live)? That is a test run, but not on the main instance.
7. **Acceptance**: 2 000 cycles + 2 h isolated soak per candidate, then 72 h live with zero orphan
   kickstarts — confirm or amend the numbers.

Resolved (Architect R23): the PM has proven it issued `POST /api/server/restart` at 18:28:54Z on 2026-09-25 during the
Car A2 live deployment. The restart was **authorized, not unexplained**. The receipt gap remains valid: the watcher could not
see or record the restart, which is what the `external-restart` receipt (R22 Q4) closes.
