---
artifact: build-plan
version: 2
scope: fix-894-timeout-detection
depends_on:
  - artifact: architecture
  - artifact: observability-strategy
governed_by:
  - artifact: architecture
    dispositions:
      - "a dependency's failure degrades TangleClaw, never crashes it → conforms; this replaces a misattributed failure with a named one"
  - artifact: observability-strategy
    dispositions:
      - "every logged error says what failed, why, and what the operator can do → this plan's whole point; the timeout path currently says what did NOT fail and sends the operator to fix it"
      - "logs carry names, never payloads → conforms; no payload added"
---

# Build plan — #894: make the timeout branches fire, and stop a hang reading as a failure

## Problem

Three hand-rolled "was this killed by our own timeout?" checks. **All three are dead code**, for two
different reasons, and the sweep that found the extra two is the point — #894 was filed naming one.

Measured on this machine rather than reasoned about:

| site | API | error on timeout | its check | fires? |
|---|---|---|---|---|
| `lib/tmux.js:53` | `execSync` | `killed: undefined`, `code: 'ETIMEDOUT'`, `signal: 'SIGTERM'` | `err.killed` | **no** |
| `lib/wrap-steps/test.js:47` | async `exec` | `killed: true`, `code: null`, `signal: 'SIGTERM'` | `err.code === undefined && err.killed` | **no** |
| `lib/wrap-steps/lint.js:57` | async `exec` | same | same | **no** |

`execSync` puts `killed` on `spawnSync`'s *result*, never on the error it *throws*. Async `exec`
does set `killed: true` — but its `code` is `null`, not `undefined`, so the compound condition
fails on its first clause. Two different wrong models of one API family.

**The wrap-step consequence is the serious one.** A test command that hangs and is killed at ten
minutes falls through to `exitCode: 1, error: null`, which is **indistinguishable from "the tests
ran and failed"**. The operator is then handed:

```
blockers:    ["Tests failed (exit 1)"]
remediation: "The test command exited non-zero. Run the suite locally, fix the failing test(s)
              shown above, and re-run the wrap."
```

There are no failing tests to fix. This is the same misdiagnosis shape as #891 — the product
confidently naming a cause that did not happen — and it costs the operator a debugging session
against a failure that never occurred.

`lib/tmux.js`'s cost is smaller: the `tmux command timed out` log line has **never once been
emitted**, so a wedged tmux server (a state #94/#144/#380 record this install reaching) is invisible.

## Confidence check

1. **Problem:** every timeout-detection branch in the repo is unreachable, so a hang is reported as
   an ordinary failure and remediated as one.
2. **Success:** a killed command is named as timed out — in the tmux log, and in the wrap step's
   exit code, blocker and remediation — and each branch has a guard that fails when reverted.
3. **Out of scope:** raising or tuning any timeout value; the wrap UI's rendering of blockers.

**Requirements confidence: High.** All three shapes were probed empirically before any code changed.

## Design

### One predicate, in one place

`lib/git.js` already carries a private `_wasTimedOut` written for #891. A fourth hand-rolled copy is
how this family got three wrong answers, so the predicate moves to **`lib/exec-timeout.js`** and all
four call sites consume it. It must handle both shapes, because this repo uses both APIs:

- `code === 'ETIMEDOUT'` — the sync throw.
- `killed === true` — the async callback.
- `signal === 'SIGTERM'`/`'SIGKILL'` — the shared fallback, and the only clause that could
  false-positive (a human `kill` mid-command). Accepted: in these call sites the only sender is our
  own timeout, and misreporting a manual kill as a timeout is strictly better than the present
  behaviour of misreporting a timeout as a test failure.

### The operator-facing text has to change with it

Fixing the branch and leaving the remediation saying "fix the failing test(s)" would ship a correct
exit code under a wrong instruction — the exact split the #891 review caught in a CHANGELOG. A
timed-out step gets its own remediation naming the timeout and the command, not the tests.

### One adjacent instance of the same class, deliberately included

`error: err && err.code === undefined ? err.message : null` also never fires for a non-numeric
code. Changed to `typeof err.code !== 'number'`.

**The reachable case is NOT the one this plan first named, and the tests are what corrected it.**
Drafting, I assumed `ENOENT` from a mistyped command. `exec` runs through a shell, so a missing
command is the *shell* exiting 127 — a number, correctly reported already. The case that actually
reaches the branch is **`maxBuffer` overflow** (`code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`), which
a suite chatty enough to exceed 10 MiB hits — and which previously arrived as a bare `exit 1` with
no error at all. Probed live, like everything else here; the guard uses that case.

That overflow is also the near-miss worth pinning: the child IS killed for it, so a looser timeout
predicate would misreport it as a timeout. It sets neither `killed` nor a signal, so `wasTimedOut`
correctly says no, and a test holds that line.

## Chunks

### Chunk 01: The shared predicate, the three call sites, and honest remediation

- **Description:** new `lib/exec-timeout.js`; `lib/git.js` drops its private copy for it;
  `lib/tmux.js`, `lib/wrap-steps/test.js` and `lib/wrap-steps/lint.js` use it. Wrap steps gain a
  timeout-specific remediation and the `ENOENT` fix.
- **Deliverables:** `lib/exec-timeout.js`, `lib/git.js`, `lib/tmux.js`, `lib/wrap-steps/test.js`,
  `lib/wrap-steps/lint.js`, `test/exec-timeout.test.js`, plus the existing git/tmux/wrap-step suites
- **Tests** — each named with the mutation it must catch:
  1. The predicate answers true for a **real** `execSync` timeout and a **real** async `exec`
     timeout, and false for an ordinary non-zero exit and a missing command.
     *Mutation:* restore `err.killed` alone → the sync case goes red; restore
     `err.code === undefined && err.killed` → the async case goes red.
  2. `tmux._exec` raises its timed-out error against a real stalling `tmux` on PATH.
     *Mutation:* revert to `err.killed` → red.
  3. A timed-out wrap test step reports exit 124, a `timed out` error, and remediation that does
     **not** tell the operator to fix failing tests.
     *Mutation:* revert the predicate → red; revert only the remediation → red.
  4. An output overflow reports its message rather than a silent exit 1 — NOT the missing-command
     case this bullet first named, which probing disproved (see Design above).
     *Mutation:* restore `err.code === undefined` → red.
- **Acceptance criteria:** no `err.killed` read survives outside `lib/exec-timeout.js`; every
  timeout branch has a guard that fails when reverted; suite green.
- **Done when:** 1. criteria met and tests pass · 2. `/prawduct:critic` run and blocking findings
  resolved · 3. committed and recorded in the change-log

## Verification strategy

1. **Unit**, driven by **real stalling executables on PATH** — not stubbed errors. #891 established
   that a stub asserts your model of the failure while the executable asserts the failure, and this
   whole issue exists because three hand-written models of these error shapes were wrong.
2. **Mutation-confirm each guard**: plant the reversion, watch it go red. Bracket the batch with a
   green baseline at **both** ends (#891's mutation run was invalidated by a racing fixture).
3. **Not verified here:** the wrap steps' real ten-minute and five-minute timeouts are not waited
   out; the guards drive `defaultExecShell` directly with a short timeout instead. The predicate is
   what was wrong, not the constant.

## Status

- [x] Chunk 01: The shared predicate, the three call sites, and honest remediation
