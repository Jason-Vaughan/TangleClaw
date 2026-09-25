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
- [ ] Architect rulings on Q1–Q7 (below). **STOP here** (dispatch boundary: no source edits before rulings)
- [ ] Chunk 01: churn/soak harness plus isolated baseline run against the installed 1.7.7_6
- [ ] Chunk 02: shared PID+generation-bound reading, action receipt, immediate boot check
- [ ] Chunk 03: root fix (the option ruled on in Q1), proven by the harness
- [ ] Chunk 04: rollout and rollback docs, CHANGELOG, watcher re-tuned to a safety net
- [ ] Verify, Critic, draft PR (pilot boundary: no merge)

**Pilot envelope (IN FORCE):** no merging any PR, no pulling or updating the live checkout, no restarting the
live service, no tests on the main instance, no tag, publish or release, no deploy. Everything below that runs
a ttyd runs an *isolated* one: its own unix socket, its own `tmux -L` server, a scratch directory outside
`~/Documents`.

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
  post-restart attaches (their elapsed time equals ttyd's). **Who restarted ttyd is unknown**
  (manual, another session, or launchd). That the watcher cannot see or record restarts it did not make is
  itself a finding (see C).

## A. Root fix options

| # | Option | Changes | TCC impact | Rollback | Planner view |
|---|---|---|---|---|---|
| A1 | **Script-side drain.** `ttyd-attach.sh` stops `exec`ing tmux. The script stays session leader, and on HUP it kills tmux, waits, flushes its own output queue from the slave side (`tcflush(0, TCOFLUSH)`, no root needed) and exits | ~20 lines of shell (or a tiny helper), reversing the "exec to leave one child" choice | None | `git revert` of one script | **Recommended first.** Cheapest, no binary change. Must be proven by the harness, because it adds a process per connection and its correctness depends on the mechanism |
| A2 | **Also cut the scrollback-replay queue.** Replay via a path that doesn't sit in the pty output queue at close, or bound its size | Script change only | None | Revert | Complements A1. It also shrinks the exposure window if A1 is imperfect |
| A3 | **Locally patched ttyd at a stable path** (`~/.tangleclaw/bin/ttyd`): 1.7.7 + #1573 + a master-side `TIOCFLUSH` before the kill (or keep reading and discard after close) | Owned build (needs `cmake`, not installed); the plist points at the new path | One-time re-grant for the new path. Afterwards, brew upgrades no longer move the grant | Point the plist back at `/opt/homebrew/bin/ttyd` | Use if A1 fails the harness. Offer the patch upstream |
| A4 | Replacement transport (TangleClaw serves the pty itself; tmux control mode) | Large rewrite; node-pty conflicts with the no-dependency stance | Varies | Feature flag back to ttyd | Not recommended now. Gotty and wetty share the same pty drain hazard |
| — | Brew upgrade to `_12` / upstream main | Dependency rebuild only | Moves the Cellar path and loses the grant | — | Tested in the harness for completeness, **not** proposed as the fix |

## B. Persistent vs transient: detection criterion

A child counts as **wedged** only if it is in `E`/`Z`, **and** (its own `etime` ≥ T_age, proposed 120 s, **or** the
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

## F. Rollout

1. Chunks 01–02 ship first (harness, shared reading, receipt, boot check). They are safe under the current ttyd
   and make the rollout observable.
2. Chunk 03 (the root fix) ships behind its own revert. For A1/A2 that is a script change that takes effect on
   the next attach, so no ttyd restart is required, but live effect needs the operator to deploy.
3. Soak on the live install with the receipts and logs as evidence. Only then relax the orphan threshold to a safety net.

## G. Rollback

- A1/A2: revert `deploy/ttyd-attach.sh`. It takes effect on the next attach.
- A3: point the plist `ProgramArguments` back at `/opt/homebrew/bin/ttyd` and reload. The original Cellar path
  and its TCC grant are untouched by the whole plan.
- Watcher and reading changes: add a `TANGLECLAW_TTYD_WATCHER=off` kill switch and
  `TANGLECLAW_TTYD_ORPHAN_THRESHOLD` (none exist today). A code revert restores the old gate exactly.

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
Chunk 03 depends on 01's baseline. Proposed: 01 ∥ 02 delegated, 03 and 04 serial.

## Questions for the Architect (rulings needed at Plan Written)

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

Unresolved separately: who restarted ttyd at 18:28:54Z on 2026-09-25. Suggest the PM asks the fleet. If it was a
session, that is a Pilot-envelope question, not a #1245 one.
