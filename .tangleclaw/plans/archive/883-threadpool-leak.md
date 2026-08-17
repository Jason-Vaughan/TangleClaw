# Build plan — Stop a hung directory from consuming the server's filesystem (#883)

**Issue:** #883 · **Branch:** `fix/883-threadpool-leak` · **Critic mode:** cumulative

**governed_by:** `architecture.md` § Direction — *"A dependency's failure degrades TangleClaw;
it never crashes it."* A managed project's directory is named there as one of those
dependencies, which is exactly what this plan is about: an unreadable one currently takes
the whole server's filesystem with it. Also `observability-strategy.md` § Direction (every
logged error names what failed and what the operator can do; logs carry names and paths,
never payloads) and `project-preferences.md` § Direction (stdlib only, CommonJS, `node:test`).

## The problem, stated

A `readdir` on a TCC-protected path does not fail — it never returns. `lib/projects.js`
runs those calls through `fs.promises`, which puts them on libuv's threadpool, so the
event loop survives. But **rejecting the timeout race abandons the promise; it does not
cancel the syscall.** The thread stays occupied for the life of the process. The pool
defaults to **4**. Once it is gone, *every* filesystem operation in the server stops —
on any path, permanently.

### What this session found that the issue does not say

**The dashboard does this to itself.** `public/landing.js:1632` runs
`loop(loadProjects, 10000)` — `GET /api/projects` every ten seconds — and
`server.js:2764` calls `listAllProjects` with no caching, so each tick issues a fresh
`fsp.readdir` on `config.projectsDir`.

If that directory is unreadable, **one pool slot leaks every 10 seconds and the pool is
gone in about 40 seconds** of simply having the dashboard open. The issue frames #883 as
an operator trying four paths in the wizard; the realistic path is worse and needs no
operator at all. *(Mechanism read from the code and confirmed; the 40-second figure is
arithmetic from the 10s poll and the measured pool size of 4, not a live measurement.)*

Reachable today on an install whose `projectsDir` is protected — an upgrade, Full Disk
Access revoked later, or the directory chosen in settings rather than the wizard.

### Why it is worse than a loud failure

`/api/health`, `/api/config` and `/api/engines` keep returning `200` because the event
loop is fine. Nothing surfaces. And `tcTimedOut` is the only signal, so once the pool is
gone the product blames **Full Disk Access for every directory** — false, and it sends
the operator to change a permission that was never the problem.

## The decision

**The parent process must never issue a blocking filesystem call on an operator-chosen
path.** Nothing else works: the syscall is uncancellable, and only killing the process
that owns a thread blocked in the kernel reclaims it. `worker_threads` is not a
substitute — workers share the process-wide libuv pool, and `terminate()` cannot
interrupt a thread blocked in a syscall.

So the walk moves into a **child process the deadline kills**.

**A long-lived child, reused across requests — not a fork per scan.** This is the
consequence of the 10-second poll above: fork-per-request means a node process spawn
every ten seconds forever, on the healthy path, to guard against a failure that almost
never happens. A supervised child answers a warm IPC round trip in the healthy case, and
is killed and respawned only when it hangs.

**Rejected alternatives**, recorded so they are not relitigated:

| Option | Why not |
|---|---|
| Raise `UV_THREADPOOL_SIZE` | Raises the number of requests needed. Does not remove the leak. Fine as defence in depth, not as the fix. |
| Per-path failure cache alone | Caps the repeat case; does nothing for an operator trying several different paths. Still worth having — see Chunk 3. |
| A bounded non-threadpool pre-check | There is none. The hang is in the kernel waiting on a TCC decision that never comes; every fs syscall on that path hangs, and the synchronous forms block the main thread, which is strictly worse. |

## Verification strategy — the part that was previously impossible

Every existing test and every VRF row used a **fresh process**, which is exactly how this
defect passed six Critic rounds, an independent PR review and 5,708 tests. The regression
test must issue more hung operations than the pool has threads **against one process**.

**Reproducing a hung filesystem call portably is solved.** Opening a reader-less FIFO
blocks, and libuv performs that open on the threadpool. Measured this session on macOS:
holding `UV_THREADPOOL_SIZE` FIFOs open via `fsp.readFile` leaves an ordinary `readdir`
permanently pending while timers keep firing — the same signature as the live bug, with
no TCC, no root and no special permissions. POSIX, so it holds on the Linux CI runner too.

That gives a genuine red/green: the test fails on `main` and passes on this branch.

> **CORRECTED IN CHUNK 1 — measured, not argued.** A FIFO reproduces *pool exhaustion*. It
> does **not** reproduce a hung `readdir`: `fsp.readdir` on a FIFO throws `ENOTDIR` in 0ms,
> as does `opendir`; `stat` and `access` return normally. Only `readFile`/`open` blocks. So
> no test can make the real scanner child hang on the real operation, and a CI-runnable
> reproduction of a TCC hang does not exist.
>
> What shipped instead: the hang is produced with the operation that *does* block, in a
> fixture child (`test/_dir-scanner-hang-child.js`), with the supervisor's `childPath`
> injectable. That covers the supervisor's contract — a child that stops answering is
> killed, its callers are told, and the parent keeps its threadpool — against a genuinely
> blocked syscall holding a genuine pool thread. **It proves nothing specific to `readdir`,
> and no test here should be read as if it did.**
>
> The red side is real and asserted rather than described. `test/_dir-scanner-pool-demo.js`
> drives `UV_THREADPOOL_SIZE + 1` blocking reads through the deadline-race shape that
> shipped before this branch — `projects._withTimeout`, which chunk 2 then deleted along
> with its last caller, so the demo carries a verbatim copy rather than keeping dead code
> alive in `lib/` to be a fixture (`git log -S_withTimeout -- lib/projects.js`), then
> times an unrelated `readdir`: every call rejects on schedule and the readdir never
> completes again. Same workload through the scanner: ~35ms. It runs as its own process
> because a process that has destroyed its own pool cannot even finish `process.exit(0)`
> (measured), so the test SIGKILLs it after reading its verdict.

## Slices

### Chunk 1: [x] The killable scanner child

New `lib/dir-scanner.js`: a supervised, long-lived child process that performs directory
work on behalf of the parent, plus the request/response protocol, the deadline, the
`SIGKILL` on expiry, and lazy respawn.

- Parent never touches an operator path; it only talks to the child.
- In-flight requests reject with `tcTimedOut` when the child is killed.
- Child death from any cause (crash, OOM, operator kill) respawns on next use rather
  than wedging the parent.
- Concurrency: requests carry correlation ids; a killed child fails all of its in-flight
  work rather than leaving callers hanging.

**Done when:** unit tests cover the healthy round trip, the deadline kill (child pid is
gone afterwards), respawn after death, and the FIFO pool-exhaustion test above —
verified red against the pre-change code path.

**DELIVERED** as `lib/dir-scanner.js` + `lib/dir-scanner-child.js`, 19 tests in
`test/dir-scanner.test.js`. Suite 5727/0 fail. Commits `4b44b2e`, `68544fb`, `f3c72b3`.

> **AMENDED DURING BUILD — collateral does NOT get `tcTimedOut`.** The bullet above says
> every in-flight request rejects `tcTimedOut` when the child is killed. Implemented
> literally, that reintroduces the misdiagnosis this issue is about: `tcTimedOut` is the
> only thing `projects._scanFailureHint` reads, and it produces the Full Disk Access
> advice. Work killed for a *sibling's* deadline did not time out and its path may be
> perfectly healthy. **Chunk 2 must branch on this:** the request that owned the expiring
> deadline gets `tcTimedOut`; everything swept alongside it gets `tcAborted`, which earns
> no hint.
>
> **The hard part was ownership, and it bit twice.** `pending` originally did not record
> which child a request was sent to, so a dying child's late `exit` failed work already in
> flight on its *replacement*. Guarding that with an identity check then created the
> mirror defect the Critic caught: a child replaced before its `exit` arrived was never
> killed (leaking the very thread this module reclaims) and never failed its own work,
> which then waited out the full deadline and reported `tcTimedOut` on a path never read.
> Both vanish once every pending entry names its owner. If chunk 2 adds a second scanner
> or a child pool, keep that invariant — it is the load-bearing one.
>
> **KNOWN LIMIT, stated as a rate.** `SIGKILL` does not unwind a thread already blocked in
> an uninterruptible kernel call, so a killed child can sit in the process table until the
> server exits and reaps it (the #380 shape; `architecture.md` calls ttyd's identical
> accumulation "the machine's first hard ceiling"). The parent's threadpool is reclaimed
> either way — that is the defect fixed — but under the dashboard's ten-second poll an
> unreadable directory produces **roughly six unreapable processes per minute,
> indefinitely**. Orphans are counted and logged as a running total. **Capping the rate is
> Chunk 3, which makes it part of the fix rather than a refinement of it.**

### Chunk 2: [x] Route the three entry points through it

`listAllProjects`, `scanDirectoryForProjects`/`_scanDirectoryEntries`, and
`createProjectsDir` are the three surfaces that touch an operator-chosen path
(`fsp.readdir`, `fsp.stat`, `fsp.access`, `fsp.mkdir`). All move behind the scanner.

`git.getInfo` runs `execSync` *inside* the walk (`lib/projects.js` ~1877, which already
documents the hazard), so moving the walk also takes that off the parent's event loop —
a real secondary win, not a side effect to leave unremarked.

**Done when:** no `fsp.*` call on an operator-supplied path remains in the parent, the
existing behavioral tests still pass unchanged, and the pool-exhaustion test passes
end-to-end through the HTTP routes rather than only at the unit level.

**DELIVERED** in `8ed4586`. No `fsp.*` call on an operator path remains in
`lib/projects.js`; the end-to-end criterion is met through the real route in
`test/api-projects.test.js`. Suite 5738/0 fail.

> **ACCEPTANCE CRITERION CORRECTED — "existing behavioral tests still pass unchanged"
> was not achievable, and could not have been.** Nine tests induced the hang by
> monkeypatching `fsp` in the test process. A stub cannot cross a process boundary, so the
> moment the walk moved, none of them reached their subject. Seven failed loudly; **two
> passed vacuously**, which is the outcome worth naming — a fixture that no longer reaches
> its subject passes forever.
>
> Their assertions are unchanged; the injection point moved. Walk behavior (marker
> short-circuiting, deadline truncation, classification, what counts as a candidate) moved
> with the code to `test/dir-scanner-child.test.js`, where `fs` can still be stubbed.
> Delegation and operator-facing wording stayed in `test/projects.test.js` behind a
> `dirScanner.request` seam. The wizard's loop-free test in `test/setup-wizard.test.js` now
> uses a **real** blocked child rather than a stub, which makes it stronger than before.
>
> **Rule for chunk 3 and beyond:** when behavior moves across the process boundary, its
> test moves with it. A test left behind still runs, still passes, and proves nothing.

> **A CHUNK-1 BUG THIS CHUNK EXPOSED.** The piped child `stderr` is a socket, and a socket
> with a `data` listener holds the event loop open by itself — independently of the child
> handle and the IPC channel, both already unref'd. Every scanner in
> `test/dir-scanner.test.js` is explicitly shut down, so it never showed there;
> `projects.test.js` uses the default scanner and never shuts it down, and simply never
> exited: tests passing, runner hanging, nothing failing to point at. Now unref'd and
> pinned by a test that runs a real process and asserts it exits.

**Deliberately out of scope:** `detectExistingProjects` (`lib/projects.js`) still
uses a synchronous `readdir`. Its own comment says every caller today is a test — verified
this session, it is called only from `test/migration.test.js` and `test/projects.test.js`.
It is a trap for whoever wires it to a route, not a live defect, so it stays and keeps its
warning.

> **FOUND WHILE DOING THIS, AND BIGGER THAN THE EXCLUSION ABOVE.** `enrichProject` calls
> `fs.existsSync(project.path)` **synchronously for every registered project**, and
> `engines.governanceState` reads more files beneath it. `listProjects` maps every row
> through it, and `listAllProjects` calls `listProjects` on its first line — so
> `GET /api/projects`, the dashboard's ten-second poll, still blocks the event loop when a
> *registered* project's directory is protected. That is the #859 wedge, still live, on the
> very route this chunk just fixed the other half of.
>
> It also falsifies a claim this plan and the code both made: that degrading to the
> registered list is safe because those rows "come from SQLite and cannot be affected by a
> stuck filesystem". The rows do; the enrichment does not. The comment has been corrected.
>
> **FILED AS #884.** 32 synchronous `existsSync`/`readdirSync`/`statSync` calls on
> operator-chosen paths in `lib/projects.js`, plus 7 in `lib/uploads.js` — the learnings
> entry already says *fix the family, not the call site*, and this is the family. It has
> its own issue and needs its own plan; it is **not** in this one.
> `detectExistingProjects`, excluded above, belongs to that sweep.

### Chunk 3: [x] Make the degraded state cheap, not merely survivable

With Chunks 1-2 a protected `projectsDir` costs a 5-second stall plus a child
kill/respawn **every ten seconds, forever**. That is survivable and still bad. Cache the
per-path failure with a TTL so a known-bad directory fails fast and is genuinely retried
only occasionally.

**Done when:** with an unresponsive `projectsDir`, repeated `GET /api/projects` answers
promptly from the cache, exactly one real attempt is made per TTL, and a directory that
starts working recovers without a restart.

**DELIVERED** in `1d4ed52`. All three criteria have their own test in
`test/dir-scanner.test.js`. Suite 5750/0 fail.

> **WHERE IT LIVES, AND WHY THERE.** The backoff is in `lib/dir-scanner.js`, not in
> `lib/projects.js` — the scanner is where the kill happens, so it is where the cost being
> bounded is actually incurred. It is **opt-in** per request (`opts.pathKey`), because a
> generic supervisor silently declining to do what it was asked would be a bad surprise.
>
> **Only `listAllProjects` opts in.** That is the polled route; nobody asked for each of
> those reads. The wizard's scan and create-directory deliberately do NOT, because an
> operator who has just granted Full Disk Access and pressed the button again must get a
> real answer rather than a remembered one — a remembered refusal there would tell them
> their fix had not worked, which is a worse version of the misdiagnosis this issue is
> about. Their cost is bounded by how fast a person can click.
>
> **Only "it did not answer" is remembered — this is the load-bearing rule.** Everything
> else is an *answer* and clears the memory: a success, and equally an ordinary error,
> because `ENOENT` means the filesystem replied. Caching `ENOENT` would break the wizard
> outright, since Create exists to turn it into a directory and the scan straight afterwards
> must see the folder just made. This is the shape of the caching bug already in this
> project's learnings (#749/#759 — a memoization that cached failures permanently because
> only the success case was considered).
>
> **Collateral (`tcAborted`) is recorded neither way**, and both directions are pinned. It
> must not mark a healthy path bad, and it must not erase a real backoff — the second was
> found by mutation after the first version of that test caught only the first.
>
> **Rate, now bounded:** 30s doubling to a 5-minute ceiling. The ceiling exists for the
> operator, not the machine: an unbounded backoff means a fixed permission goes unnoticed
> for an unbounded time. This closes chunk 1's R-19, which the Critic waived to here rather
> than calling fixed.

## What this plan does NOT do

- **#880** (moving the shipped default off `~/Documents`) — separate issue. It reduces
  exposure and does not fix the leak.
- **Rewording the Full Disk Access message.** The misattribution is a *consequence* of
  pool exhaustion making every path time out. Fix the leak and `tcTimedOut` means what it
  says again. Re-check at the end rather than pre-emptively editing copy.

  > **RE-CHECKED at the end of chunk 3, as this line asked. No rewording needed — and the
  > reason is worth stating, because "we didn't change it" and "we checked and it is right"
  > look identical afterwards.** `tcTimedOut` is now set in exactly two places, and both
  > mean the same thing: the supervisor's own deadline expiring on a path, and a remembered
  > refusal of a path that expired one recently. Every other failure was given its own
  > vocabulary along the way — `tcAborted` for work killed as collateral (whose path may be
  > healthy), `tcTruncated` for a walk that WAS being answered but ran out of budget, and
  > ordinary errnos for a filesystem that replied. None of those reach `_scanFailureHint`.
  > So the sentence now fires only when a directory genuinely did not answer, which is the
  > one condition Full Disk Access is the remedy for. The copy was never wrong; what was
  > wrong was everything else arriving wearing its flag.

- Raising `UV_THREADPOOL_SIZE`. Worth considering afterwards as defence in depth; it is
  not part of the fix and must not be mistaken for one.

  > **DECIDED: not doing it, and it should not be revisited as a leftover.** It was only
  > ever a way to raise the number of hung reads needed to exhaust the pool. No operator
  > path consumes a pool thread in the server process any more, so there is now nothing for
  > a larger pool to protect: it would raise a ceiling nothing reaches.

## Requirements Confidence

**High** on the defect, the mechanism and the reproduction — all three read from the code
and the pool exhaustion reproduced locally this session.

**Medium** on the supervision design. A long-lived child is the right call given the
10-second poll, but the concurrency model (one child multiplexing correlated requests vs.
a small pool of children) is a judgement made against the current single-caller reality
and may want revisiting under real load.

[ASSUMPTION: one scanner child is enough. There is exactly one route family calling this
today and the dashboard polls it every 10s, so contention is a queue of at most a few
requests. If a second consumer appears, revisit before adding parallelism.]
