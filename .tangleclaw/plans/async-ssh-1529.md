---
scope: async-ssh-1529
---

# Blocking ssh calls off the event loop (#1529)

**Issue:** #1529

Critic mode: final

## Problem

On 2026-09-16 the host moved networks and the server's saved OpenClaw hosts stopped answering.
Every synchronous `ssh` the server ran then held the Node event loop for its whole connect timeout,
so WebSockets dropped and the dashboard kept reloading. #1527 (PR #1528) fixed the version read.
Three more request handlers still run `ssh` synchronously:

- `POST /api/openclaw/detect-instance-dir` → `lib/openclaw-detect.js` `detectInstanceDir`
  (`execSync`, 15 s timeout, script piped on stdin).
- `POST /api/openclaw/connections/:id/approve-pending` → `_runOnGatewayHost` in `server.js`
  (`execFileSync`, up to 15 s per call, several calls per approval via `lib/openclaw-approve.js`).
  The dashboard fires this route in bursts (20 calls ≈ 3.2 s each on 2026-09-16 04:00Z).
- `POST /api/openclaw/test` in `server.js` (`execSync` ssh, 10 s, then `execSync` curl, 5 s).

## Confidence check

1. **Problem:** any of these three routes, pointed at a host that doesn't answer, freezes the whole
   server for up to 10–15 s per call (longer for approve, which runs several commands).
2. **Success:** each route answers exactly as today (same JSON, same codes, same error text
   shapes), but while its ssh is waiting the server keeps serving other requests. Pinned by a
   test per route that proves a timer runs while the command is still pending, plus the existing
   behavior tests converted to async stubs.
3. **Out of scope:**
   - `lib/tunnel.js`'s `ps`/`lsof` helpers: local, bounded at 3 s, normally milliseconds, and
     called from sync paths. #1529 listed `GET …/tunnel`, but its 6–12 s on 2026-09-16 was the
     *awaited* connect probe and HTTP round-trip, which don't block the loop.
     [DECISION: descoped and corrected on #1529.] The server's overall shell-out rate is tracked
     separately.
   - Deduplicating the dashboard's approve-pending bursts (UI behavior, `public/`).
   - Any change to the JSON these routes return.

Requirements confidence: High.

## Decisions

- [DECISION: `lib/openclaw-approve.js` becomes async end to end.] Its `runRemote` seam now returns
  a promise; `resolveDockerBin`, `findContainer` and `approvePending` await it. The seam's result
  shape `{ok, stdout, stderr, code}` is unchanged.
- [DECISION: one new module, `lib/openclaw-remote.js`, owns the non-blocking runners] — `runShell`
  (with stdin input) and `runFile` (argument vector, no shell), behind one `_internal` seam the route
  tests stub. The routes shelled out inline with nothing to stub, and detect needs stdin, which
  promisified `exec` can't pass. Its tests drive real processes, because the async error shapes are
  what this repo has modelled wrongly before (`lib/exec-timeout.js`).
- [DECISION: `_runOnGatewayHost` uses async `runFile` and keeps its contract]: same result shape,
  same redaction of `opts.secret`, and `code` is the numeric exit status or `-1`. A timeout is
  reported through `lib/exec-timeout.js` `wasTimedOut` rather than by reading the error's fields
  directly (#894: async and sync errors differ in shape).
- [DECISION: `detectInstanceDir` keeps its shell command and its `_internal.exec(cmd, opts)` seam],
  now async and backed by `runShell` with the script on stdin. That keeps the command-shape tests
  unchanged; an `execFile` rewrite would have changed them for no behavioral gain.
- [ASSUMPTION: the route tests can stub these seams without a real host] — as
  `test/openclaw-version-route.test.js` does.
- Engine-agnostic: no engine involvement.

## Chunk 01 — async detect, approve and connection test

Files: `FEATURES.md`, `lib/openclaw-remote.js`, `lib/openclaw-detect.js`, `lib/openclaw-approve.js`, `server.js`,
`test/openclaw-remote.test.js`, `test/openclaw-detect.test.js`, `test/openclaw-approve.test.js`,
`test/openclaw-ssh-routes-nonblocking.test.js`, `CHANGELOG.md`.

Done when:
- The three routes return what they returned before for success, failure and unsafe input, and no
  ssh runs for an unsafe target.
- A route test per path proves a timer runs while the stubbed ssh is still pending, and the test
  fails if the call is made synchronous again (mutation-checked).
- `_runOnGatewayHost` still redacts `opts.secret` from stderr, and a timeout is reported as one.
- The runners are tested against real processes: stdin input, exit code + stderr on failure,
  timeout detection, argument vectors passed without a shell, and a timer running mid-command.
- Suite green (`test/*.test.js`); Critic final with zero blocking.
- Live, after merge and restart (the server runs from the primary checkout, not this branch):
  `POST /api/openclaw/test` against the unreachable 192.168.20.10 returns its SSH error while another
  request answers promptly. Result recorded in the PR.
- A timeout reads as one on all three routes (`… timed out after Nms`), and no failure message
  echoes the ssh command line.

## Status

- [ ] Chunk 01 — async detect, approve and connection test
