# #1771 — List root-owned listeners in `GET /api/ports` `systemPorts`

*Dual-Builder Pilot 2, Lane 1. Branch `fix/1771-root-listeners` (fresh off `origin/main` @7aa12e05). Dispatched by the PM on 2026-09-24.*

## Status

- [x] Plan written; architectural items sent to the Architect. **STOP here** (dispatch boundary: "Halt at Plan Written")
- [x] Architect has ruled on A1–A4 (2026-09-24: A1–A3 approved, A4 modified; see Rulings). PM gave the go 2026-09-24, next boundary Draft PR
- [x] Build: whole-table socket scan + merge + tests + docs + CHANGELOG (`### Fixed`)
- [x] Verify: focused tests + full suite (this checkout, not the main instance): green. Live `scan()` on this host lists 22/88/443/445/5900/8444, named, matching `probePort`
- [x] Critic (2026-09-24: first review 0 findings / 11 observations, acted on or recorded; second review 0 blocking / 0 warnings, two fixed and the rest accepted; verify-resolutions on `26867bec`: 0 findings, 2 observations accepted)
- [x] Draft PR opened: #1844. **STOP here** (pilot boundary)

**Pilot envelope (IN FORCE):** no merging any PR, no pulling/updating the live checkout, no restarting the
live service, no tests on the main instance, no tag/publish/release, no deploy.

## Problem

`GET /api/ports` (`server.js`, the `/api/ports` route) builds `systemPorts` from
`portScanner.getSystemPorts()`, the cache that the periodic `port-scanner.scan()` fills. `scan()` runs only
`lsof -iTCP -sTCP:LISTEN -nP`. Run as a non-root user, lsof sees only that user's sockets. The lease guard
(`probePort`) already falls back to the kernel socket table (`netstat -anv -p tcp` on darwin,
`ss -Hltn` on linux, #814 cumulative round), so the two surfaces disagree: the listing says a port is
free and the lease refuses it with `PORT_IN_USE`.

**Reproduced live on this host (2026-09-24, as the operator user):**

- lsof LISTEN ports: 3002 3009 3010 3102 3198 3200 3201 3280 3281 3283 3330 5000 5432 5433 7000 8080 8181 8443 18789 18800 52837 52838 55409
- netstat LISTEN ports: all of the above **plus 22 88 443 445 4778 5900 8444 38364 38843 55930 57682**
- `netstat -anv -p tcp` takes about 5 ms and already includes the tcp6/tcp46 rows. Its pid column
  resolves through `ps` for root-owned pids (e.g. `1 → launchd`).

## Confidence check

1. **Problem:** `systemPorts` leaves out every unleased listener lsof cannot see, even though the
   lease guard refuses those ports.
2. **Success:** every port that `probePort` would report as in use (with no lease) appears in
   `systemPorts` after the next scan. That means the same two sources, lsof plus the socket table, feed
   both the listing and the guard. On this host, `GET /api/ports` lists 22, 443, 5900 and 8444.
3. **Out of scope:** changing `probePort`'s behavior or result shape; making the scan
   asynchronous; UDP; non-localhost hosts; the scan interval and `portScannerEnabled`; any UI (nothing
   under `public/` reads `systemPorts`).

Requirements confidence: **High**. The issue names the fix ("the periodic scan also reads the socket
table"). A1–A4 are the only open shape questions.

## Design

`lib/port-scanner.js`:

1. **Whole-table parsers.** `_parseNetstatListeners(output)` returns `[{ port, pid|null }]` for every
   LISTEN row. `_parseSsListeners(output)` returns `[{ port }]`. Both dedupe by port. The existing
   single-port `_parseNetstatListener(output, port)` / `_parseSsListener(output, port)` are
   folded into the whole-table parsers, so each format has exactly one parser (see item 2).
2. **One socket-table reader, `_readSocketTable()`**, returns `[{ port, pid|null }]`, or `null` when it
   could not answer. Both callers use it, so the listing and the guard cannot drift apart on what the table
   holds. `_socketTableListeners()` (for the scan) names every pid with **one batched**
   `ps -p <pid,pid,…> -o pid=,comm=` (`_commandsOf`, taking the basename of comm, which can contain
   spaces, e.g. `/Library/Application Support/…/dvsd`). `_socketTableListener(port)` (for the probe)
   names only the pid it found, with `_commandOf`, because a lease decision does not need every
   listener's name. A pid `ps` cannot name stays `command: null`. On linux both pid and command are
   `null`. The single-port parsers become production-dead and are removed, and their tests move onto
   the whole-table parsers with the same inputs *(amended during the build after Critic
   observation 1; the original text had the probe's reader "become a lookup" but kept it separate)*.
3. **`scan()` merges.** lsof entries come first and win on a shared port, because they carry pid and
   command. Socket-table-only ports are appended. If the socket table fails, the result is lsof's
   answer, logged at debug (the same stance as the probe). If lsof fails (no stdout) and the table
   answers, the result is the table's entries. Today that case caches `[]`. If both fail, the result
   is `[]`, as today.
4. **`scan()` runs through the `_exec` seam** instead of the `execSync` import it calls directly
   today, so tests can drive it without the host's listeners. `test/_probe-stub.js` already answers
   non-matching commands with "exit 1, empty". Under the stub, a scan therefore reads as empty, which
   is what the suites that install it expect.
5. `getSystemPorts()` return type widens to `{ port, pid: number|null, command: string|null }[]`, with
   JSDoc updated. The route's own comment in `server.js` is updated to say the cache now includes the
   socket table.

Cost: one extra `netstat` (≈5 ms) plus one `ps` per scan (default every 60 s, synchronous as today).
That is negligible next to the existing lsof call.

### Tests

`test/port-scanner.test.js`:
- `_parseNetstatListeners`: every LISTEN row across address shapes (`*.22`, `127.0.0.1.3102`, `::1.x`,
  IPv6 scoped), non-LISTEN rows skipped, dedupe, a `-` pid becomes `null`. `_parseSsListeners`: IPv4/IPv6/
  `%lo`-scoped, dedupe, empty input.
- `scan()` with a stubbed `_exec` on darwin: a root-only port (in netstat, not in lsof) appears with
  the pid and the `ps`-given name; a port in both keeps lsof's pid/command; `ps` is called once for all
  pids; a pid `ps` cannot name gives `command: null`.
- `scan()` on linux: ss-only port appears with `pid: null, command: null`.
- Failure matrix: table fails → lsof result; lsof fails and table answers → table result; both fail → `[]`.
- **Parity (the success criterion as a test):** for a fixture host (the same stubbed lsof/netstat/ps
  output), every port `probePort` reports `inUse` is in `getSystemPorts()` after `scan()`.
- The two existing "scan returns an array / populates the cache" tests stay as written. They still
  run the real host commands, because they call `scan()` before any `_setExec`.

`test/api-ports.test.js`: `GET /api/ports` passes a socket-table entry (`pid: null, command: null`)
through unchanged, and still excludes leased ports.

### Docs (same commit)

- `data/porthub-guide.md` (the `systemPorts` sentence): the list includes listeners owned by other users/root.
  On linux their `pid`/`command` can be `null`. `CLAUDE.md`'s generated block regenerates from it at launch
  and is not hand-edited.
- `FEATURES.md` PortHub entry: `systemPorts` is fed by the same two sources as the guard.
- `CHANGELOG.md` `[Unreleased]` → `### Fixed` (patch). An operator sees 22/443/… appear in the listing.

## Risk found while planning: a host-dependent assertion that breaks on Linux CI

`test/engines.test.js` ("port scanner conflict detection works with checkPort", about line 2686) calls the
real `scan()`, takes the first unleased `systemPorts` entry, and asserts `result.process` is truthy
from `checkPort`. CI runs on `ubuntu-latest`. Once the scan reads `ss`, a root listener there (sshd 22,
systemd-resolved 53) becomes a candidate with no pid, and `probePort` returns `process: null`, so the
test fails on CI but passes on macOS. See A4: the fix changes the test's premise, not its strength.

## Architectural decisions (sent to the Architect)

**A1 — Merge precedence and nullable identity.** *Recommend:* lsof wins on a shared port. Socket-table-only
entries carry `pid`/`command` as `null` when they cannot be named (always on linux). They are listed
rather than dropped, because the issue's contract is "every port a lease would be refused on".
*Rejected:* dropping unnamed entries (reopens the gap on linux); inventing a placeholder
command string like `"unknown"` (a fake value a caller could match on).

**A2 — Response shape: no new field.** *Recommend:* keep `{ port, pid, command }` with nullable
pid/command, which is additive-compatible for existing readers. *Alternative:* add
`source: 'lsof'|'socket-table'` per entry. It is useful for diagnosis, but it widens a fleet-surface
contract for no caller that needs it today.

**A3 — `scan()` goes through the `_exec` seam.** *Recommend:* yes (design item 4). It makes `scan()`
testable and matches `probePort`. The side effect: suites that install `test/_probe-stub.js` and call
`scan()` now see an empty scan instead of the host's. I'll check with `git grep` during the build that
no suite depends on a real scan under the stub (the current reading says none do).

**A4 — `test/engines.test.js` host-dependent assertion.** *Recommend:* keep the test's contract
("checkPort agrees with what the scanner saw") and fix its premise. Pick the first unleased entry
**that has a command**, and separately assert that `checkPort` reports every unleased entry as
`available: false, systemDetected: true`. This is stronger than today, because it now covers every
entry and not just one. `process` is asserted only when the entry had one. Better still would be to
drive the test from fixtures via `_setExec` so it stops depending on the host. That is my preferred
option if the Architect agrees it is in scope; otherwise I'd file it as a `[chore]`.
*Rejected:* leaving it (red CI on ubuntu); dropping the `process` assertion outright (a weakening).

## Rulings

Ruled by the Architect over Medusa on 2026-09-24 (msg `b91b735d`). The architectural gate is cleared **within this
scope only**. Implementation, Critic, review, CI, PR and merge gates stay with the builder and the pilot.

- **A1 — APPROVED.** lsof wins on a shared port, because it has the richest identity. Listeners only the socket table
  sees stay visible, with an explicit `null` identity.
- **A2 — APPROVED.** Keep `{ port, pid, command }`. `pid`/`command` widen to documented nullable fields. No
  `source` field, since no caller needs one.
- **A3 — APPROVED.** Every `scan()` subprocess goes through `_exec`, so scan and probe share one deterministic seam.
- **A4 — MODIFIED (binding).** Replace the engines test's real-host selection with deterministic
  `_setExec` + `_setPlatform` fixtures. Assert explicitly that **both** a named lsof listener **and** an unnamed
  socket-table-only listener are `available: false, systemDetected: true`, and assert `process` only for the named
  one. **No conditional real-host coverage is kept.** This replaces the A4 recommendation above (the
  "first unleased entry that has a command" option is dropped).

PM ruling (2026-09-24): the branch and PR stay strictly scoped to #1771, and the Pilot 1 plans are not archived here.
