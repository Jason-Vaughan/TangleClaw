# Release-candidate soak — load and fault schedule

The load side of the 72-hour release-candidate soak (#2020, part of #1949). It builds a
**deterministic** schedule of load and faults, then runs it against a TangleClaw server inside
an isolated test guest. Every outcome goes to an append-only log.

It judges nothing. Whether the release candidate passes is decided by the release-certification
judge (`rc-cert`) and the soak's own acceptance gates. This tool only produces the conditions and
records what happened.

> **Status: Chunks 1, 2 and 3.** This directory has the schedule, the runner and an executor for every
> kind in the catalogue (`api`, `engine`, `browser` and `fault`), the stub engine, the guest definition
> (`guest/`), the generator for the synthetic `soak-*` repos, the integrity sampler and the evidence
> bundle. The operator procedure is two runbooks:
> [install and start the pinned candidate](../../docs/runbooks/soak-install-the-candidate.md), and
> [run, sample and bundle the soak](../../docs/runbooks/soak-run-sample-and-bundle.md).
>
> Not built yet: the certification judge that reads a bundle (Chunk 4 of #2020, with the link to
> rc-cert). Until it exists, nothing but `run`'s exit 5 acts on a log's ownership-unverified
> disposition.
>
> The server and ttyd run as launchd agents in the workload user's GUI session. Per Architect ruling A1,
> that user gets a login secret generated inside the guest and never exposed, and the guest logs it in
> automatically (install runbook, step 8). Without that session, `fault.server.restart` and
> `fault.ttyd.restart` have no launchd job to act on.

## Build a schedule

```sh
node scripts/soak.js plan --seed rc-5.30.0 --phase certifying --duration-hours 72 \
  --out soak-certifying.json
node scripts/soak.js validate --schedule soak-certifying.json
```

- **The same seed and flags always give the same schedule and the same `digest`**, so the evidence can
  name exactly what a run was put through, and a rerun can reproduce it.
- **The phase decides the fault catalogue.** Neither phase can put an owned-ttyd restart into a
  certifying run:
  - A `certifying` schedule **never** contains an owned-ttyd restart (`fault.ttyd.restart`). That
    fault changes the ttyd generation, which fails a certification outright.
  - A `destructive` schedule may contain one. Run it in its own phase, then reset to a pristine
    guest before certification begins.
  - `validate` rejects a certifying schedule that contains that fault even if it was edited by hand
    and its digest recomputed.
- **Faults are spaced by at least `--fault-quiet-ms`** (default: 10 minutes), so the system gets a
  window to recover before the next one.
- **The params must be written out in full**, exactly as `plan` writes them. A key deleted by hand is
  refused, not silently defaulted.
- **The params have fixed limits, so a hand-edited schedule cannot widen them:**
  - project names must be synthetic (`soak-…`);
  - lease ports stay at 5000 or above, outside TangleClaw's own ranges;
  - an engine cycle sends at most 20 commands;
  - the load and fault gaps have floors, and a certifying schedule keeps at least a minute between
    faults (the default is ten);
  - a schedule holds at most 300,000 events. A 72-hour run at the one-second floor is 259,200.
- **`plan` never overwrites** an existing schedule file.
- **A schedule names its catalogue** (`tc.soak-schedule/v2`). Adding a kind changes what a seed
  draws, so a schedule from an earlier catalogue is refused (`SCHEMA`), never read as the same run.

## What the load does

| Kind | Class | Weight | What it proves |
|---|---|---|---|
| `api.health`, `api.server-info`, `api.projects.list`, `api.ports.list` | api | 6, 3, 4, 3 | The read routes keep answering. |
| `api.ports.lease-release` | api | 2 | A port lease and its release both succeed, under `soak-harness`. |
| `api.plans.read` | api | 1 | `GET /api/projects/<p>/plans` lists `soak-plan.md`, and the page at its `urlPath` answers 200. |
| `api.medusa.reads` | api | 1 | The fleet-wide switchboard reads, deliveries then escalations, keep answering. |
| `engine.session.cycle` | engine | 3 | A stub session launches, takes commands, and is killed. |
| `engine.session.medusa-cycle` | engine | 1 | Two stub sessions on distinct projects both reach `listening`; a message from one is delivered to the other's inbox and marked handled; both are killed. |
| `engine.session.wrap-cycle` | engine | 1 | A stub session is wrapped with every AI-content step skipped; the run the `202` named finishes, succeeds, and ends the session. |

- **The plans, switchboard and wrap kinds are drawn rarely.** Each makes several requests, and the
  two engine cycles launch sessions and run the wrap pipeline. At a higher weight they would crowd
  out the steady light load that shows a slow leak.
- **The switchboard cycle needs two projects.** A schedule with one project never draws it, and
  `validate` rejects one added by hand, as it does a cycle whose two projects are the same or not in
  the schedule.
- **The plans read fetches only a page on the target.** The page is HTML, so only its status and
  length are recorded. A listing whose `urlPath` resolves anywhere else is refused (`FOREIGN_LINK`)
  and never requested, since the request would carry the soak's token.
- **Every wait is bounded.** Both listeners have a minute to reach `listening` (`NOT_LISTENING`,
  naming the laggard), the message a minute to arrive (`NOT_DELIVERED`), and the wrap ten minutes to
  finish (`WRAP_TIMEOUT`). Their states are read once a second.
- **How a wrap cycle is judged:**
  - `409 STRANDED_WRAPS` is `WRAP_STRANDED`; any other refusal is `HTTP_STATUS`.
  - `409 WRAP_IN_PROGRESS` is a failure, and the session is **not** killed: another run owns it.
  - A status naming a different run is ignored. A run claimed and never settled is `WRAP_STALE`.
  - Success is the run's `ok` and its pipeline's `ok`, never `result.status`, which reads
    `wrapping` even on success. Otherwise it is `WRAP_BLOCKED`, with `blockedAt` when known.
  - A successful run that did not end the session is `WRAP_NOT_ENDED`.
  - The session is killed afterwards only when the run did not end it.
- **Every engine cycle kills only what the harness launched.** Both projects of a switchboard cycle
  pass the same status check as a session cycle (below) before anything launches. Once a launch
  succeeded, both sessions are killed at the end whatever failed between, and a failed kill is
  reported (`cleanupFailed`). Killing the recipient retires the exchange, so the message needs no
  reply and no close.
- **The message and its request id name the run and the event**
  (`soak-medusa-<runKey>-<index>`, where `runKey` is the schedule digest's first 16 hex characters
  and the log's start time). The server keeps request ids unique across all its sends, so scoping
  the id to the run keeps a second soak against the same target from colliding with the first.
  The send is **not** idempotent: a resumed event re-sends under its earlier id, the server refuses
  it (409 `SEND_ALREADY_ATTEMPTED`) rather than sending again, and the cycle records that as its own
  outcome, `SEND_ALREADY_ATTEMPTED`, never as a failed send.

### Prerequisites on the target

These kinds need a target prepared as `guest/guest-setup.sh` prepares it:
- **A Medusa hub** reachable at the TangleClaw process's `MEDUSA_BRIDGE_HTTP_URL` (default
  `http://localhost:3009`, with the WebSocket on the next port). Without it no listener reaches
  `listening`. The guest is offline, so setup provides the stub hub (setup step 6, and
  [The stub hub](#the-stub-hub)).
- **Each `soak-*` project's `.tangleclaw/project.json`** has `medusaEnabled: true`,
  `wrapAutoPrEnabled: false` and `releaseMode: "off"`, and the project has a
  `.tangleclaw/plans/soak-plan.md`. The seed commit carries all of these (see
  [The synthetic repos](#the-synthetic-repos)).
- **First-run setup is finished** (setup step 5), or the dashboard shows the setup wizard.
- **The driver runs on the guest's loopback**, so the front-door gate treats it as a machine
  client.

### What this load does not exercise

The guest is offline and the engine is a stub, so:
- real AI-content capture in a wrap (every such step is skipped);
- the wrap's push and pull-request path (`wrapAutoPrEnabled: false`);
- bound switchboard replies and exchange closes: the message needs no reply, and the recipient's
  kill retires the exchange.

**These are certification gates, not waivers** (Architect ruling A32). Each of them must be
exercised, or explicitly gated, by the exact-head acceptance and preflight of the guest dry run
before any soak time counts. A certifying run does not start while any of them is unmet: real
AI-content capture, the push-and-PR path, and the governed switchboard lifecycle (bound replies
and closes). This load keeps the rest of those paths under stress; it does not stand in for them.

### Certifying in a guest: host-attested checks and the relay

The guest has no route to GitHub, so a certifying run in it uses the judge's host-attested mode
(ADR 0021 points 10 to 12): the host mints the run id (`rc-cert host-mint`), answers every
sample's required checks (`rc-cert host-checks --watch`), finalizes the run against its own ledger
(`rc-cert host-finalize`), and relays the guest's local `metrics` branch to the public remote
(`rc-cert host-publish`). The guest runs `rc-cert start --checks-source host-attested --run-id
<id> --exchange <dir> --metrics-remote <local bare repo> --isolation-producer <guest-setup.sh> …`,
and every sample also attests the guest's network isolation (ADR 0021 point 13): the runner calls `guest-setup.sh --verify-network` with the sample's binding. That runs both raw verifiers afresh and prints, through `lib/soak/attest-bridge.js`, one bound `{admin, workload}` pair, or a bound `{breach}` envelope when a verifier positively measured an unsafe fact (exit 3 with `code: BREACH`), or nothing when it could not measure. The raw `--verify-admin` and `--verify-workload` modes stay for direct diagnostics. The transport between host and
guest (Chunk 1) mirrors the exchange directory and brings the guest's `metrics` repository to
the host. Certification of record exists only as the host's record.

## Run it

```sh
TANGLECLAW_SERVICE_TOKEN=… node scripts/soak.js run --schedule soak-certifying.json \
  --api http://<guest-ip>:<port> --log soak-certifying.ndjson
```

- **`--api` is required and has no fallback.** The load writes port leases and sessions, so before
  any load `run` refuses the TangleClaw named by this pane's own `TANGLECLAW_API`
  (`LIVE_INSTALL_TARGET`) in three ways:
  - **By spelling.** It refuses the same origin, and any spelling of this machine on the live port,
    in either scheme:
    - loopback: `127.0.0.0/8`, `[::1]`, and IPv4-mapped forms such as `[::ffff:127.0.0.1]`;
    - `localhost` and any `*.localhost` name, with or without a trailing dot;
    - the hostname or its MagicDNS name;
    - any local interface address.
  - **By address.** With a live install to protect, `--api` must name the guest by **IP address**
    (`TARGET_NOT_IP_LITERAL` otherwise), and an address on this machine at the live port is refused.
    - A hostname is resolved once when checked and again when connected to, and nothing binds the
      two. A name could resolve elsewhere at the check and to `127.0.0.1` at the connection (DNS
      rebinding). An IP literal is never resolved, so the address checked is the address connected to.
    - `TANGLECLAW_API`'s own name *is* resolved. When it is a Tailscale or LAN name rather than the
      hostname, `127.0.0.1` on the live port is still refused, and a live name that does not resolve
      counts as this machine.
  - **By identity.** It asks both servers for `/api/server-info` and refuses a target that reports the
    same running server (`startedAt` and `startupSha`), which catches a reverse-proxy route.
- **A redirect is never followed.** A target that passed every check could answer `307` and have
  the request replayed, body and all, to any host, the live install included. Every soak request asks
  for no redirects. A 3xx from the load is recorded as a failed outcome (`REDIRECT_REFUSED`, with its
  `location`), and a 3xx from an identity check counts as unreadable.
- **If the live install's identity cannot be read, `run` refuses** (`LIVE_IDENTITY_UNREADABLE`).
  `--allow-unverified-live` overrides this, and the override is recorded in the log. If only
  the target cannot be read, `run` warns (`IDENTITY_UNCHECKED`) and carries on: a target that answers
  nothing, or answers `401`, answers the load the same way.
- **With no `TANGLECLAW_API`, `run` refuses (`GUARD_CONTEXT_ABSENT`) unless `--no-live-install` is
  given.** Every guard compares against `TANGLECLAW_API`, so without it nothing is guarded, and that
  has to be stated rather than assumed.
  - Inside the soak guest, where the driver targets the guest's own TangleClaw, pass
    `--no-live-install`. The log records it.
  - Passing it where `TANGLECLAW_API` is set is a usage error.
  - Neither override is ever passed on the operator's behalf, least of all by certification.
  - **Every run segment records what its guards established and the overrides it ran under.** The
    first segment's go in the log header. Each resumed segment appends and flushes a `resume` record,
    with its own `guard` results, its overrides and where it resumed from, before it does any work.
    An override given only when resuming is still in the evidence.
- **The target must already have the synthetic projects** (`--projects`, default `soak-a`,
  `soak-b`, `soak-c`) and no delete password. Otherwise every session cycle is logged as a `404`
  or `403`.
- **The token comes from `TANGLECLAW_SERVICE_TOKEN` only.** `--token` is refused.
- **The log is `0600`, and one driver holds it at a time** (`<log>.lock`, `LOG_LOCKED`).
  - A lock left by a dead process on this host is reclaimed by exactly one contender, which holds the
    `<log>.lock.reclaim` mutex and replaces the lock in one atomic rename. The reclaim is logged.
  - An unreadable lock, a live holder, a holder on another host, or a reclaim already in progress
    is refused, naming the file to remove if you are sure no driver is running. An unreadable
    lock in front of an open segment whose owner is dead is refused for good (see below, including
    the one exception).
  - Each record is flushed to disk before the next event.
  - **Ownership is re-checked before every log write and before every event**, so the check just
    before `end` is exact. The moment the lock is found removed or taken over:
    - nothing more is written to the log, not even a note about the loss, because writing without
      the lock is what the lock forbids;
    - the loss is recorded beside it in a fail-only sidecar, `<log>.lock-lost`. The sidecar is
      created atomically and fsynced, and binds the log's absolute path, its size and sha256 at that
      moment, the expected holder and the one observed;
    - the run fails with `LOCK_LOST`, or with `LOCK_LOST_UNRECORDED` if even the sidecar could not
      be written. The log is then never complete.
  - **While a sidecar exists, the log is refused everywhere**: reading it, resuming it, rerunning
    it, or judging it (`LOG_LOCK_LOST`). A sidecar that does not bind the log, was altered, or cannot
    be read is refused too (`LOG_LOCK_LOST_INVALID`), so tampering never turns a refusal into
    acceptance. Start a new log.
  - **A lock that cannot be read at all is a third case, `OWNERSHIP_UNVERIFIED`.** Nothing shows
    another writer, but ownership cannot be shown either, so:
    - the run stops before any further event or append, as for a loss;
    - no sidecar is written, the lock is left exactly as it is (a lock that cannot be read is not
      the run's to remove), and the segment stays open;
    - the log resumes only through an exact-owner reclaim: the lock must again name the marker's
      exact owner, that owner must be dead, and every marker/log binding must still hold. The
      resumed segment is recorded as ownership-unverified (below). Otherwise the log stays refused.
  - A lock the run still owns but cannot remove is a different failure, `LOCK_RELEASE_FAILED`. The
    log is intact; only the lock file is left behind.
- **Every run segment is bracketed by a durable marker, `<log>.segment`.**
  - It is created and fsynced before any work, and binds the log's path, the owner and the bytes the
    log held at the start.
  - It is removed only when every append of the segment is durable and its exact owner released the
    lock.
  - **A graceful stop (Ctrl-C, SIGTERM) is committed while the lock is still held:**
    1. a `stop` record is appended and fsynced;
    2. the marker is atomically replaced by a `stopped-clean` one that binds the whole log as it now
       stands;
    3. the lock is released;
    4. the marker is removed as cleanup.

    If the process dies before cleanup, a later run checks that the log is byte-for-byte what the
    stop recorded and resumes, even with no lock. If the lock is lost before the stop commits,
    neither the stop record nor the transition is written.
  - While it exists, in either state, the log is not evidence: `readLog` refuses it
    (`LOG_SEGMENT_OPEN`). A stopped run is never a completed certification.
  - A later run tells the ways a segment can be left open apart by the lock:
    - **The old lock names exactly the marker's owner, a dead process on this host.** An ordinary
      crash leaves this. So does a run stopped by `OWNERSHIP_UNVERIFIED` whose lock later read back,
      and the two cannot be told apart. The segment is resumed, and **every such resume is recorded
      as `recoveredFrom.state: "ownership-unverified"`** in the new segment's first record. That
      includes a log that was already complete: its `resume` record is still appended.
    - **A marker whose owner is dead, and whose lock is gone, names someone else, holds no identity,
      or cannot be read**, may be a lock loss whose sidecar could not be written. It is refused for
      good (`LOG_SEGMENT_UNRECONCILED`): the refusal is recorded in the bound `<log>.lock-lost`
      sidecar, so no lock restored later, even one naming the exact owner, resumes the log. Start a
      new log. If the sidecar cannot be written, the refusal says so (`details.condemnError`), and
      the log must be checked by hand before any use.
    - **Exception: "for good" holds only once the refusal is recorded.** When the log's whole
      directory is unreadable at recovery, nothing in it can be read or written. The run is refused
      (`LOG_LOCK_LOST_INVALID`, naming the unreadable directory in `details.directoryUnreadable`), but
      nothing can record that refusal. The same holds when the sidecar write fails
      (`condemnError`). Once the directory is readable again and the lock names the exact dead
      owner, the log resumes through the ordinary exact-owner reclaim. That resume is still recorded
      as ownership-unverified, so the log is never a clean result or an automatic pass.
    - **A marker whose owner may still be running, or is on another host**, is refused without
      recording anything (`details.condemned: null`). It may be a run finishing right now, between
      releasing its lock and closing its segment.
  - **An ownership-unverified segment is never a clean result.**
    - `run` reports `completed-ownership-unverified` or `already-complete-ownership-unverified`,
      never `completed`, with `ownershipUnverified: true`, and exits 5.
    - `readLog` returns `ownership.verified: false` with each `unverifiedSegments` entry, and a
      `certification` disposition: `automaticPassAllowed: false`, `defaultDisposition: "fail-reset"`.
      The Operator may accept the log instead, but only its exact evidence: the disposition names
      the log's path, size and sha256, and `acceptanceMatches` holds only for an acceptance of
      exactly those. These fields are what the certification judge will read, and nothing reads
      them yet: the judge is not built (see the status note at the top).
    - A resume that fails before its `resume` record is durable (a wrong `--schedule`, a damaged
      log, a failed write) releases nothing and closes nothing. It reports `recoveryPending`, and
      leaves the lock and segment as a crash would, so the next run can only resume through the same
      exact-owner reclaim, which records the mark again. A failure never erases the mark.
  - A marker that was altered, or no longer matches the log, is refused (`LOG_SEGMENT_INVALID`). That
    includes a `stopped-clean` marker whose log has changed since the stop.
  - **A marker that cannot be removed at the end fails the run with `SEGMENT_CLOSE_FAILED`.** The
    log is intact, but nothing reconciles the leftover marker automatically: start a new log, or
    reset it by hand after checking the log. If the marker was removed but the directory fsync
    failed, whether it survives a crash is unknown, and the failure says so (`cleanup: "unknown"`)
    rather than claiming the marker remains (`cleanup: "marker-remains"`).
  - An error the run hit for another reason is always reported first, with any lock outcome
    attached.
- **The log is evidence, so nothing rewrites it.** Reading it changes nothing. A final line torn by
  a crash is sealed by appending after it: a newline, then a `torn-tail-sealed` record that binds that
  exact fragment by byte offset, length and sha256. Its event runs again.
  - Damaged bytes are accepted only when a seal matching them byte for byte comes straight after
    them. A seal binds a byte range. That range is usually one torn line, and it spans more when the
    seal's own write was torn and the next resume sealed the leftovers.
  - Unsealed damage is accepted only at the very end of the log, as the pending leftovers of the
    last crash, and the next run seals it.
  - A mismatched seal, damage altered after sealing, a stray seal, or damage in the middle of the log
    with no seal makes the log unreadable (`LOG_UNREADABLE`).
  - A log that survived several crashes, each sealed, still resumes, whichever byte a crash cut.
  - **Known limit: a check-then-write window.** Ownership is checked immediately before each append,
    not atomically with it. A process that took a live holder's lock by hand in that instant could
    precede one append. Release still detects the takeover and condemns the log. Nor can a lock that
    was unreadable for a while and then read back be told from one that never changed: that is why
    every exact-owner resume is recorded as ownership-unverified. Closing the window
    would need `flock`, a native module this zero-dependency project does not use. Accepted by the
    Architect.
  - **Known limit: the log is not signed.** Seals detect accidental damage, not forgery. Someone
    who can write the file can compute a correct sha256 and forge a seal that hides a record. Making
    it tamper-evident would need a keyed MAC or a hash chain anchored outside the host.
- **Ctrl-C stops within a second, before the next event** (exit 4), even during a long wait, and says so on stderr. Running the same command again resumes, and no
  logged event runs twice.
- **An engine cycle cleans up only the harness's own sessions.** It first reads the project's
  session status:
  - a leftover `soak-stub` session, left by a cycle torn by a crash, is killed (`preKilled: true`);
  - a session on any other engine is never touched, and the cycle fails with `FOREIGN_SESSION`;
  - if the status cannot be read, the cycle kills nothing.
- **On time, every event runs at its slot. Behind schedule:**
  - Load more than a minute past its slot is **skipped and recorded** (`skipped: true`,
    `SKIPPED_STALE`), never replayed as a backlog.
  - Faults are **never skipped, only deferred**. A fault never starts within the quiet window of the
    previous executed fault, including one the log shows ran before a restart. Every fault runs
    before the log ends.
  - Overdue load that is not yet stale runs at least a second apart.
  - Each record says what applied (`paced`), and `lateMs` says how late it started.
  - A deferred fault delays the load queued behind it, and load that goes stale during that wait is
    skipped and recorded like any other stale load. That is intended: faults take priority over load.

Exit codes: 0 done, 2 usage, 3 refused (the code is printed as JSON on stderr), 4 stopped, 5 done but with an ownership-unverified segment (not an automatic pass).

```sh
node scripts/soak.js run --schedule s.json --api http://<guest-ip>:<port> --log s.ndjson [--allow-unverified-live] [--no-live-install] \
  [--home <guest TangleClaw home>] [--webdriver http://127.0.0.1:<port>]
```

`--home` and `--webdriver` are for schedules with fault and browser events (see below). Such a schedule
runs only inside the guest, against `--api http://127.0.0.1:<port>`.

## Fault and browser events

Faults and browser events act on the machine the driver runs on, not only through `--api`: they restart
launchd jobs, kill a tmux session, lock the database file, fill the disk and drive Safari. So a schedule
with any of them runs only where `lib/soak/local.js` admits it, and `run` refuses
(`LOCAL_CONTROL_REFUSED`, naming every unmet condition) before any load otherwise:

- `--no-live-install`, which in turn needs `TANGLECLAW_API` unset;
- the machine is a virtual machine (`kern.hv_vmm_present` is 1), so an operator's own Mac is refused
  even from a pane with no `TANGLECLAW_API`;
- `--api` is a loopback IP literal, so the server the load reaches is the one the faults act on;
- `--home` is the guest TangleClaw's home (its `TANGLECLAW_HOME`, `~/.tangleclaw` for the workload user):
  an absolute, plain directory owned by the driver's user, holding a `tangleclaw.db` it owns;
- for browser events, `--webdriver` is a loopback IP literal: `safaridriver -p <port>`.

The header's `guard.local` records the home, the WebDriver and the uid a run was admitted with.

| Kind | Phases | What it does | It passes when |
|---|---|---|---|
| `fault.server.restart` | both | `POST /api/server/restart`, the product's own launchd kickstart. A running wrap's `409 WRAP_RESTART_BLOCKED` is retried for up to 10 minutes and never forced. | A server with a new `startedAt` answers within 3 minutes, and health is 200. |
| `fault.tmux.session-kill` | both | Launches its own stub session, then `tmux kill-session -t =<name>` on exactly the session that launch named, after checking the name and the stub engine. | The server reports the session not active within a minute. |
| `fault.client.abort` | both | Cuts off five reads a few milliseconds in. | The same server (same `startedAt`) answers health within 2 minutes. |
| `fault.db.lock-contention` | both | Holds `BEGIN EXCLUSIVE` on `tangleclaw.db` for 5 s while a read and a port lease are tried, then rolls back. | The same server recovers. What the probes got while locked is recorded (`during`), not judged. |
| `fault.disk.pressure` | both | Writes real ballast under `<home>/soak-ballast/` down to 2 GiB free (at most 64 GiB), holds it 30 s under probes, then removes it. | The same server recovers. Too little headroom is `NO_HEADROOM`, not a pass. |
| `fault.ttyd.restart` | destructive | `launchctl kickstart -k gui/<uid>/com.tangleclaw.ttyd`, as `lib/ttyd-watcher.js` does. It refuses (`NOT_DESTRUCTIVE`) in any other phase too. | launchd runs a ttyd with a new pid within a minute, and health is 200. |
| `browser.dashboard.load` | both | Opens `/` in Safari. | The dashboard's own script fills the uptime stat from the API within 30 s. |
| `browser.terminal.attach` | both | Launches its own stub session and opens `/session/<project>`. | The terminal frame renders xterm, and the server's `/api/system/pty-activity` counts a new attach on the same server instance. |

- **Every fault touches only what it owns or the guest serves:** its own stub session, `tangleclaw.db`
  under `--home`, the ballast directory under `--home`, and the guest's own launchd jobs.
- **Ballast a dead run left is removed** before the next disk fault writes any. Only files named
  `ballast-*.bin` are ever removed.
- **Browser events need the front-door gate off.** A browser is not a machine client, and the soak holds
  no login, so with the gate on the dashboard never renders (`NOT_RENDERED`). Each event ends its
  WebDriver session whatever failed, because Safari runs one at a time.
- **A render that times out says why, where the page can tell.** The event then reads the page's
  state and records `SETUP_WIZARD` when the first-run setup wizard covers it (the target was never set
  up), `PAGE_HIDDEN` when the page is not visible (no display, or a locked or sleeping screen), and
  `NOT_RENDERED` otherwise. The page's `visibility` is kept with the outcome. A hidden page never
  runs work it defers to an animation frame, which is how the session page sets its terminal.

## Integrity samples

```sh
node scripts/soak.js sample --home ~/.tangleclaw --api http://127.0.0.1:3102 --out samples.ndjson --no-live-install \
  [--interval-ms 600000] [--count <n>] [--full-every 6]
```

- **Each sample** (`tc.soak-samples/v1`) records:
  - the database's `quick_check`, or its full `integrity_check` on the first sample and every
    `--full-every`-th after, through a read-only connection;
  - the server's resident memory and open descriptors, for the pid in `<home>/tangleclaw.pid`;
  - the disk's free and total bytes;
  - `/api/health`'s status.
- **`corrupt` means SQLite reported damage:** a check that returned problems, or a file that is corrupt
  or not a database. A check that could not run, for example on a database the server holds locked,
  is `unavailable`.
- **Either check holds a shared lock while it runs**, so the server's writers wait for it. On the soak's
  small database that takes milliseconds.
- **The file is `0600`, and one sampler holds it at a time** (`<out>.lock`; `SAMPLER_LOCKED`). A lock
  whose process is gone is taken over.
- **A sample that fails is recorded (`sample-failed`, with its error), and sampling carries on.** A
  server whose memory cannot be read (a `ps` that failed or timed out) is recorded as `alive: null`
  with a `reason`, never as down.
- **Running it again continues the file:** sequence numbers carry on. A file for another home is
  refused (`SAMPLES_MISMATCH`), and so is one ending in a torn line (`SAMPLES_TORN`).
- **It runs only in the guest**, admitted like the faults (`LOCAL_CONTROL_REFUSED` otherwise).
- **Ctrl-C stops it between samples** (exit 0).

## Evidence bundle

```sh
node scripts/soak.js bundle --out <new dir> --schedule s.json --log s.ndjson [--samples samples.ndjson] \
  [--attestations a.json,b.json] [--home ~/.tangleclaw --no-live-install]
```

- **It copies each input into a new `0700` directory, owner-only:**
  - the schedule;
  - the log, byte for byte, with any `.lock-lost` or `.segment` sidecar beside it;
  - the samples;
  - each attestation, under `attestations/`.
- **With `--home` it also snapshots `tangleclaw.db`** (`VACUUM INTO`, one consistent read) to
  `db/tangleclaw.db`, and runs `integrity_check` on the copy. `--home` is admitted like the faults,
  so the snapshot is only taken in the guest.
- **`manifest.json` (`tc.soak-evidence/v1`) binds every file by size and sha256.** The command prints
  the manifest's own sha256. Its `summary` holds:
  - the schedule's validity and digest;
  - the driver's own reading of the log: its disposition, or its refusal;
  - whether the log belongs to that schedule, with outcomes and failure codes by kind. `ended` is the
    driver's verdict on whether the run finished; `endRecordSeen` is only the summary's own parse,
    kept for a log the driver refuses;
  - the samples' coverage (first and last time, largest gap, failed samples) and their worst readings;
  - the snapshot's verdict.
- **It judges nothing, and never refuses because the run went badly.** A log the driver will not read as
  evidence is still bundled, with the refusal recorded, because that is the run to investigate.
- **It refuses only what would make the bundle untrustworthy** (`BUNDLE_REFUSED`, exit 3):
  - an existing `--out`;
  - a missing or symlinked input;
  - two attestations with the same file name;
  - a schedule that is not JSON.

## The stub hub

The guest has no network, so no real Medusa hub can run in it. Without a hub, no session's switchboard
listener ever reaches `listening`. `deploy/soak/medusa-stub/medusa-stub.js` is a hub that speaks only the
part of the protocol the candidate uses, so `engine.session.medusa-cycle` exercises the candidate's own
listener, send route, inbox and read path from end to end. **It certifies TangleClaw's side of the
switchboard, not Medusa.**

- **Loopback only, by construction.** It binds `127.0.0.1` and `::1`, because `localhost` can resolve to
  either, and it refuses to bind anything else.
- **What it serves:**
  - HTTP: `POST /messages/direct`, `GET /workspaces` and `GET /health`.
  - WebSocket: `register`, answered with `registered`; heartbeats; `new_message` pushes; and `ack`,
    answered with `ack_response`.
- **Message ids and delivery:**
  - One id names a message everywhere: the send's answer, the pushed envelope and the message itself.
    That id is what the cycle's delivery check matches.
  - A message stays queued until its recipient acknowledges it. A workspace that registers again is sent
    everything still queued. A workspace that never registered answers 404.
- **It needs no credentials,** because the candidate sends none. Nothing persists: a restart forgets
  every queue.
- **It uses Node built-ins only.** Node 22 has no WebSocket server, so the handshake and framing (RFC
  6455) are written out in the script. Client frames must be masked, and fragmented frames are refused.
- **Setup runs it as a LaunchAgent** in the workload user's GUI session (setup step 6), so launchd
  restarts it if it dies during a run and loads it again at login. It logs to
  `~/Library/Logs/soak-medusa-stub.log`.

## The stub engine

The guest has no network access and holds no vendor credentials, so the `engine` load uses
`stub-engine/soak-stub.js`:
- It is a deterministic program with no network access. Each input line gets
  `ack <n> <sha256 prefix>`, and `/exit` ends it.
- In the guest it is installed as `soak-stub` on `PATH`, with `stub-engine/soak-stub.json` copied into
  `~/.tangleclaw/engines/`.

It exercises TangleClaw's side of a session: launch, tmux, ttyd, command injection and kill.
**Real-vendor engine behaviour is outside this soak.**

## The synthetic repos

The load targets projects that must exist on the target. `repos` creates them:

```sh
node scripts/soak.js repos --root ~/Projects --origins ~/soak-origins [--projects soak-a,soak-b,soak-c]
```

- **Each project is `<root>/<name>`, with a bare origin at `<origins>/<name>.git`.** The origin is a
  local path, never a network remote, and nothing is pushed anywhere else. `--root` must be the
  target TangleClaw's `projectsDir`.
- **The names follow the schedule's rules** (`soak-…`, at most 20, no repeats), and the default set is
  the schedule's own, so the repos and the load agree.
- **The seed commit already holds what the candidate would otherwise add or the load would miss:**
  - `.tangleclaw/project.json`, naming the stub engine, joining the switchboard, and wrapping with no
    pull request and no release. An attach keeps it.
  - `.tangleclaw/plans/soak-plan.md`, the plan `api.plans.read` looks for.
  - `.tangleclaw/memories/MEMORY.md` and `CHANGELOG.md`. The candidate writes each only when it is
    missing, so committing them keeps the work tree clean. A file the session did not make would
    otherwise stop every `engine.session.wrap-cycle` at `session-files`.
- **Each repo's seed commit has the same SHA on every machine and every run.**
  - It is built from a fixed tree, author, date and message. The operator's git config, `GIT_*`
    environment and hooks are all kept out.
  - The SHA is also computed without git, and a commit that differs is refused (`SEED_MISMATCH`).
  - The output carries each seed SHA and a `digest` of the set, so evidence can name exactly which
    repos a soak ran against.
- **The seed tree:**
  - `.soak-synthetic.json`, the marker;
  - `.tangleclaw/project.json`, naming the `soak-stub` engine;
  - `CHANGELOG.md`;
  - `README.md`;
  - `src/index.js`.

  Because of the first two, attaching the project to TangleClaw picks the stub engine and adds nothing
  to the work tree.
- **It touches only repos it made.**
  - A repo is owned when its git config holds `soak.owner = tc.soak-repos/v1:<name>`, its origin's
    does too, its `origin` remote is exactly that local path, and its history contains the seed commit.
  - Anything else at either path is refused with `NOT_OWNED` and left untouched: a file, a symlink,
    an empty directory, a plain directory inside some other repo, a repo with another marker or
    remote, or a work repo whose origin is gone.
  - Every path is inspected before anything is written, so a refusal creates nothing.
- **Running it again is safe.**
  - An owned repo is reported `present` and not written to.
  - `pristine` says whether the work repo and its origin still sit exactly at the seed. A soak moves
    them on, and that does not make them any less owned.
  - Each repo is assembled in a `.soak-staging-*` directory and renamed into place, origin first. A
    crash between the two renames leaves an owned origin with no work repo, and the next run rebuilds
    the work repo from that origin. A process killed mid-build can leave a `.soak-staging-*`
    directory behind; it is never mistaken for a repo, and can be removed by hand.

Exit codes: 0 done, 2 usage (including relative, identical or nested roots, or a refused project
list), 3 refused (`NOT_OWNED`, `SEED_MISMATCH` or `GIT_FAILED`, printed as JSON on stderr).

## The guest

`guest/` defines the isolated macOS guest the soak runs in, as files. Nothing here runs by itself.
Creating, starting or deleting a VM, installing tart, and changing host networking are the operator's
actions.

- **`guest.conf`** holds the pinned settings: VM name, base image, CPU, memory, disk, the one shared
  directory, the guest's projects and origins roots, and the synthetic project names.
  - Every value can be overridden from the environment. Record what was exported with the run's
    evidence.
  - It holds no secrets.
  - The base image and the tart flags are operator-checked: confirm them against the installed tart
    before the first run.
- **`pf/soak-deny.conf`** is the default-deny network profile.
  - Loopback is unfiltered, so the guest's TangleClaw, ttyd and the driver can talk to each other.
  - Two other things are allowed, both only on the guest interface (`$guest_if`):
    - SSH in from the host's address (`$host_addr`), the operator's management path. pf's state lets
      only that session's replies out; the guest cannot open a connection.
    - DHCP, client port 68 to server port 67 only, so the guest keeps its address, and with it the
      management path, for a 72-hour run. Broadcast is allowed for DISCOVER, REQUEST and REBIND.
      Unicast RENEW goes only to the DHCP server (`$dhcp_server`), and replies come in only from it.
      That server is `SOAK_DHCP_SERVER`, which must be set to the host-controlled service the dry run
      proved, and must match the single server identifier in the guest's current lease. A server read
      from the lease alone is refused, and it is never assumed to be the SSH host.
  - There is no DNS, no IPv6 beyond loopback, no egress and no route to production.
- **`host-provision.sh`** runs on the host.
  - Before it reads `guest.conf`, it checks that it can trust its own checkout. `host-provision.sh`,
    `guest.conf` and every directory above them must be plain (no symlink or ambiguous path), owned by
    root or the operator, and not writable by group or others.
  - By default it only prints the `tart clone`, `tart set` and `tart run` commands.
  - It runs them only with **both** `--execute` and `SOAK_OPERATOR_APPROVED=1`. That is a safety
    interlock, not authority: creating a VM stays the operator's decision.
  - It refuses to reuse an existing VM of the same name: a certification starts from a pristine guest,
    and deleting one is the operator's call.
  - `SOAK_TART_DISPLAY` picks the guest's screen: `no-graphics` (the default, no display at all) or
    `vnc` (a real framebuffer reached over VNC, with no host window). Anything else is refused.
  - **`--closure` is the host-side isolation layer** (Architect ruling A7). It stops the named guest,
    which must already exist, and runs it again with its share under softnet:
    `--net-softnet --net-softnet-block=0.0.0.0/0 --net-softnet-allow=in @host`. softnet then drops
    everything the guest sends, except replies to connections the host opens, so SSH from the host
    still works. It never creates a guest, and it keeps the share's contents. It needs the same
    `--execute` and `SOAK_OPERATOR_APPROVED=1`.
  - The shared directory is the only host path the guest sees, read-write, so it must be a dedicated
    one, `/Users/Shared/tc-soak-share` by default. The script compares real paths, following symlinks
    and `..`. It refuses:
    - `/` and `$HOME`;
    - any directory that contains `$HOME` (such as `/Users`);
    - any directory inside `$HOME` (such as `~/.ssh`);
    - a relative path;
    - a directory that does not exist;
    - a directory not owned by the operator, or writable by group or others;
    - with `--execute`, a directory that isn't empty: a new guest gets a new, empty share. It is a place
      for inputs and evidence, never for trusted code.
- **`guest-setup.sh`** runs inside the guest, as the admin, from a checkout of the pinned release
  candidate that the workload user can read and nobody else can write (such as `/opt/tangleclaw-soak`;
  see the trust check below).
  - **The guest TangleClaw runs as the workload user, never as the admin.** Its sessions are the
    workload, and a session with sudo could turn pf off.
  - A fresh guest therefore goes in three steps:
    1. `guest-setup.sh --bootstrap-user` creates or confirms the workload user and stops.
    2. Start the pinned TangleClaw as that user on `127.0.0.1:SOAK_TC_PORT`. That is the runbook's step.
    3. `guest-setup.sh` sets up the rest.
  - Setup and the admin verifier refuse a TangleClaw listening as anyone else, checked with `lsof`
    against the workload user's uid.

  Every mode first:
  - **checks the checkout can be trusted** (every mode, `--verify-workload` included), before
    `guest.conf` is even read. The admin sources `guest.conf`, loads the pf profile and installs the
    stub engine; setup runs `soak.js` as the workload user. Anyone who could change those files could
    run code as the admin or the workload, or rewrite the firewall. The files checked are:
    - `guest-setup.sh`, `guest.conf` and `pf/soak-deny.conf`;
    - `scripts/soak.js` and every `lib/soak/*.js`;
    - the stub-engine files;
    - every directory above them, up to `/`.

    Each must be:
    - a plain file or directory: no symlink, and no path that resolves somewhere else;
    - owned by root or the invoking admin;
    - writable by neither group nor others.

    There is no exception, not even a root-owned sticky directory like `/Users/Shared`. On the workload
    side, the checkout's owner stands in for the admin, and must not be the workload itself.

    Once the workload user is known, setup and every admin attestation also run a check as that user,
    which must fail to write any of those files or directories. A positive control first shows that
    checks run as that user work at all. `--bootstrap-user` repeats the check after creating the
    account.

    **So put the checkout in a dedicated hierarchy owned by root or the admin, mode 0755, such as
    `/opt/tangleclaw-soak`.** The workload can read it and nobody else can write it;
  - refuses to run where `TANGLECLAW_API` is set (a live pane), outside macOS, or on a machine that is
    not a VM (`kern.hv_vmm_present`);
  - validates its inputs, so nothing ambiguous reaches pfctl, sudo or a URL: the interface name, the
    host's IPv4 address, the workload user name, the port, the project names and the probe timeout.
    The egress probe addresses must be public literals, because a malformed or unroutable address would
    fail for reasons that have nothing to do with pf, and "prove" nothing. node's own parser
    (`net.isIP`) and a block list judge them, not a pattern. The block list refuses:
    - for IPv4: loopback, private, link-local, CGNAT, documentation, benchmark, multicast and reserved
      addresses;
    - for IPv6: the reserved `::/8` block (which holds unspecified, loopback, IPv4-mapped and NAT64
      addresses), discard, IETF protocol, documentation, unique-local, link-local and multicast
      addresses.

    The probed addresses are also recorded in the attestation.

  Setup then, stopping at the first failure:
  1. **Creates or confirms the workload user** (`SOAK_WORKLOAD_USER`, default `soakrun`). It is a
     standard account with a random password nobody keeps. It refuses an existing account with that
     name whose identity conflicts: a system uid (below 501), a home other than `/Users/<user>`,
     membership of `admin` or `wheel`, or any sudo rights. It never adopts, changes or demotes such an
     account; fix one by hand.
  2. **Loads the pf profile and attests both planes** (below). The admin verifier runs as its own
     `--verify-admin` process, so its line, `ok: false` included, is always printed. Either verifier
     failing stops setup.
  3. **Installs** `soak-stub` on `PATH`, and its engine profile for the workload user. It creates the
     install directory (`SOAK_BIN_DIR`, default `/usr/local/bin`) first: a macOS 26 base image has none.
  4. **Creates the synthetic repos** as the workload user (`soak.js repos`), under its home.
  5. **Finishes the guest TangleClaw's first-run setup, then attaches each project** through its own
     API. With the guest's auth gate down, it uses the dashboard client header. With the gate up, it
     refuses and tells you to finish setup and attach from the dashboard. It never reads or writes a
     token.
     - **Setup is finished the way the wizard's last step finishes it** (`POST /api/setup/complete`),
       with the choice of no login and `projectsDir` set to `SOAK_PROJECTS_ROOT`. Until setup finishes,
       the dashboard shows the wizard instead of the stats `browser.dashboard.load` waits for. The
       install's default `projectsDir` is under `~/Documents`, which macOS privacy protection stops a
       launchd-run server reading without a prompt nobody can answer.
     - **A later run finds setup finished and checks it.** Setup then refuses unless the guest's config
       says `setupComplete: true` and `projectsDir` is `SOAK_PROJECTS_ROOT`.
  6. **Starts the stub Medusa hub.** It leases `SOAK_MEDUSA_HTTP_PORT` and `SOAK_MEDUSA_WS_PORT`
     (default 3009 and 3010, which must be adjacent) in the guest TangleClaw's port registry. It writes
     a LaunchAgent into the workload user's `~/Library/LaunchAgents` and loads it into that user's GUI
     session, replacing one an earlier run loaded. Then it waits for the hub's `/health` on loopback.
     It refuses if a port is leased to something else, if launchd will not load the agent, or if the
     hub never answers.

  Every step is safe to repeat.

### Attestation

The guest is attested from two planes, because neither can see everything.

- Each verifier prints exactly one JSON line (schema `tc.soak-guest-attest/v1`), built by a real encoder
  (node's `JSON.stringify`) rather than by pasting strings together.
- A successful line carries `ok: true`, the boot identity (`kern.bootsessionuuid` and the boot time), the
  time, and the artifact version: `scriptSha256` and `profileSha256`, the sha256 of `guest-setup.sh` and
  of the pf profile, reported separately.
- Any failure or ambiguity is `ok: false` with `code: "REFUSED"` and a `reason`, and exit 3.
- If node itself is missing, a fixed line with `code: "ENCODER_MISSING"` is printed, with nothing
  interpolated.

- **`guest-setup.sh --verify-admin`** runs as the admin, with sudo, and inspects pf itself:
  - pf must report `Enabled`;
  - the loaded ruleset must equal pfctl's own parse of the profile with the same macros
    (`pfctl -n -v`), so no pfctl output format is assumed, and must have the profile's rule count;
  - `lo0` must be skipped.

  It reports:
  - the sha256 of the expected rules and of the active rules, and whether they match (a mismatch is
    also reported this way, with `ok: false`);
  - the guest interface and its IPv4 address, and the host's address;
  - the DHCP server pf allows and the lease's own server, which must match;
  - the lease's timing, normalized to epoch seconds: start, expiry, renewal and rebinding, the raw start
    as reported, when it was observed, and how many seconds remain. `dhcp.timingSource` says where the
    renewal and rebinding times came from:
    - `lease`: the lease reported both `renewal_t1_time_value` and `rebinding_t2_time_value`.
    - `derived-rfc2131`: the lease reported neither, only `lease_time`, which is what Tart's vmnet DHCP
      server sends. They are then RFC 2131's defaults (section 4.4.5), the timers a conforming client
      uses when the server sends none: renewal at half the lease, rebinding at seven-eighths of it,
      each rounded down to a whole second. A derived time is only what a conforming client should do,
      not proof that this guest's client does it. Under the closure no renewal is due, and the dry run
      checks the lease stays the same instead (see the DHCP limits under **Known limits** below).

    It fails closed when:
    - `ipconfig getsummary` doesn't report `LeaseStartTime` exactly once, in one of two forms:
      - `YYYY-MM-DD HH:MM:SS +ZZZZ`, which carries its own zone;
      - `MM/DD/YYYY HH:MM:SS`, which macOS 26 prints with no zone. `ipconfig` prints this form in the
        time zone of the process that calls it, so the verifier calls it with `TZ=UTC` and reads the
        result as UTC. Nothing then depends on the admin's shell or the guest's configured zone. It must
        name a real calendar day and time.

      `dhcp.leaseStartForm` (`zoned` or `utc`) and `dhcp.leaseStartUtcOffsetMinutes` record which form
      was read and the offset used, so the evidence shows how the start was interpreted;
    - `ipconfig getsummary` reports `LeaseExpirationTime` (in either form) and it isn't exactly
      `LeaseStartTime` plus `lease_time`, or it reports it twice or in neither form. On a real macOS 26.3
      guest the two agree. The raw value is attested as `dhcp.leaseExpiryRaw`, which is `null` when the
      summary has no expiry line;
    - the start is before 2000 or in the future;
    - the lease has expired;
    - the lease doesn't report `lease_time`;
    - the lease reports one of the renewal and rebinding times but not the other. Neither shape above
      covers that, so nothing is derived;
    - the renewal, rebinding and lease times, whether reported or derived, don't satisfy
      0 < renewal < rebinding < lease strictly (equality fails). A lease too short to derive distinct
      whole-second timers fails here;
    - a lease field appears twice or doesn't parse;
    - less lease remains than the next sample interval plus a declared margin (`SOAK_SAMPLE_INTERVAL`,
      default 600 s, plus `SOAK_SAFETY_MARGIN`, default 300 s), so a lease can't lapse unseen. All three
      numbers are in the line;
  - that something is listening on port 22, the SSH management path;
  - that the TangleClaw on `SOAK_TC_PORT` is exactly one process, running as the workload user and
    executing `node`. The proof starts from the listening socket. `lsof` resolves exactly one pid, whose
    uid must match from both `lsof` and `ps`. Its executable comes from `lsof`'s text entries, the
    kernel's view of what the process has mapped: exactly one may be a node binary, and it is recorded
    canonicalized. `ps`'s command name isn't used, because on macOS it is the process's own `argv[0]`;
  - that the workload account is still what setup made: a regular uid (501 or above), its own home
    owned by it, in neither `admin` nor `wheel`, and with no sudo rights. Group membership is judged
    by `dseditgroup -o checkmember`'s exit status: 0 is a member, 67 is not, and any other status leaves
    membership unknown and is refused. Sudo rights are judged by the
    exit status of `sudo -l -U <user> <command>`, for a shell, `pfctl` and a no-op. Two positive controls
    come first: the admin can run `sudo -n true` right now, and the same query says yes for the admin.
    After that, only exit status 1 counts as the policy's "no". A 0 means the workload has sudo, and a
    hang or any other status means unknown. Either is refused;
  - the checkout trust above, and that the workload can't write any of it. `artifact.guestConfSha256`
    records exactly which settings were attested.

  It never loads pf.
- **`guest-setup.sh --verify-workload`** runs as the workload user and proves what that user can and
  cannot do. It never inspects pf, because the workload must not be able to.
  - It must be running as that user, with a non-system uid, in neither `admin` nor `wheel`.
  - `sudo` and `pfctl` must both be refused to it. A hang doesn't count as a refusal.
  - Loopback must answer on `127.0.0.1` and `::1`, and so must the guest TangleClaw's `/api/health`.
  - Nothing outside may answer: TCP to a literal IPv4 and a literal IPv6 address, and a DNS query over
    UDP sent straight to a resolver's address. None of it depends on DNS. The addresses probed are in
    the JSON line (`probes`), so the evidence shows what was tested.
- **Every probe is killed after `SOAK_PROBE_TIMEOUT` seconds** (default 10). A probe that hangs is a
  failure, never a pass, including an egress probe, where a hang proves nothing.

The soak runner (a later chunk) joins the two attestations at admission, at every evidence sample and
at finalization. It binds them to the run and fails closed on a mismatch or a stale one. A reboot
changes the boot identity, so no time survives one.

**Known limits.**
- **The admin's own `node` and `PATH` are trusted as given.** The admin runs helpers found on its
  `PATH`: `node` to encode each attestation and canonicalize paths, and `shasum`, `stat`, `lsof`, `ps`,
  `pfctl` and `sudo` for the checks themselves. **No workload-writable directory may appear on the
  admin's `PATH`.** A directory the workload can write would let it replace any of those helpers and
  run code as the admin. The runbook must install node where only root or the admin can write it, and
  run setup and every `--verify-admin` with a `PATH` made only of such directories.
- **The IPv6 probe check refuses known reserved blocks, not every unallocated address.** An address such
  as `4000::1` passes as public. The dry run's positive control (the probes must answer with pf
  disabled) catches a probe that could never have answered.
- **Two layers, and only one is attested.** pf inside the guest is the boundary the verifiers attest.
  softnet on the host (`host-provision.sh --closure`, install step 11b) is a second layer beneath it,
  which a compromised guest cannot turn off. No verifier inspects softnet, so the evidence records the
  closure command and relies on the guest's own denial probes.
- **pf rules do not survive a guest reboot.** Before T+0 that is expected: the closure restarts the
  guest, and setup runs again on the new boot (install step 11b). After T+0, a reboot invalidates the
  run: the boot identity changes, so no time survives one.
- **Screen Sharing (TCP 5900) may be on in the base image.** It is not exposed: pf drops everything
  inbound except SSH from the host, and the verifiers check pf's rules, not the guest's listeners.
- **The DHCP allowance is itself a small channel out.** Any local process that can bind UDP source port
  68 (macOS allows that without root) can send to `255.255.255.255:67` and to the DHCP server's port
  67. That traffic stays on the tart vmnet segment and reaches only the host's DHCP service. It is the
  price of keeping the address, and the SSH path, through a 72-hour run. A static address would remove
  it, if the dry run shows one is workable.
- **Under the closure, softnet's DHCP lease does not expire** (Architect ruling A8). No renewal happens,
  so the dry run checks that the address, the lease and SSH stay the same from start to end (install
  step 12) instead of waiting for a renewal. The allowance below still stands for tart's default
  network.
- **The DHCP allowance is a best effort at keeping the management path**, not a proof. It depends on
  macOS's DHCP client renewing with the configured server over the allowed ports, and on the
  `ipconfig` output forms the verifier parses (`getpacket`, and `getsummary`'s `LeaseStartTime` and
  `LeaseExpirationTime`). A census of a real macOS 26.3 guest has confirmed both forms. It also watched
  a renewal keep the address and accept a new SSH session under this pf profile, although no attested
  run has observed one yet. The verifier fails closed when a form differs. On tart's
  default network, a dry run would have to show the address and SSH surviving a real lease renewal,
  especially when the timing is `derived-rfc2131`: the verifier then attests when a renewal *should*
  happen, never that one did. The soak runs under the closure instead, where the lease never expires,
  and step 12 of [Install and start the pinned candidate](../../docs/runbooks/soak-install-the-candidate.md)
  checks that the address, the lease and SSH stay the same. If they do not, the fallback is a static
  address or an independently proven tart console path. A derived timing, on its own, is not a reason
  to fall back.
- **Egress denial needs a positive control in the dry run.** A probe that fails proves isolation only if
  the same probe succeeds when egress is open. The dry run must therefore run the workload verifier's
  probes once with pf disabled and see them answer, before trusting their denial with pf loaded. The
  verifier can't do this itself, because it must never touch pf.

The dry run and the certifying run then drive the guest's own TangleClaw from inside the guest, with
`run --no-live-install`.
