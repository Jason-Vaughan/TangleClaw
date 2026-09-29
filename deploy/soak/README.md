# Release-candidate soak — load and fault schedule

The load side of the 72-hour release-candidate soak (#2020, part of #1949). It builds a
**deterministic** schedule of load and faults, then runs it against a TangleClaw server inside
an isolated test guest. Every outcome goes to an append-only log.

It judges nothing. Whether the release candidate passes is decided by the release-certification
judge (`rc-cert`) and the soak's own acceptance gates. This tool only produces the conditions and
records what happened.

> **Status: Chunks 2A (the core) and 1 (the guest and the synthetic repos).** This directory has the
> schedule, the runner for the `api` and `engine` load classes, the stub engine, the guest definition
> (`guest/`) and the generator for the synthetic `soak-*` repos. Not built yet:
> - installing and starting the pinned release candidate inside the guest (the operator runbook);
> - the executors for the `browser` and `fault` classes;
> - integrity sampling, the evidence bundle and the operator runbook;
> - the certification judge (Chunks 3 and 4 of #2020, with the link to rc-cert). Until it exists,
>   nothing but `run`'s exit 5 acts on a log's ownership-unverified disposition;
> - **Chunk 2B, mandatory before the first guest dry run** (Architect ruling):
>   - API load against plans and the switchboard (this chunk, 2A, covers health, server-info,
>     projects and ports);
>   - stub-engine sessions that exercise wrap and the switchboard (2A's engine cycle covers launch,
>     commands and kill);
>
> Until the missing executors exist, `run` **refuses** any schedule containing those kinds
> (`NO_EXECUTOR`) rather than skipping them. Plan with `--classes api,engine` to run the load
> that exists today.

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
node scripts/soak.js run --schedule s.json --api http://<guest-ip>:<port> --log s.ndjson [--allow-unverified-live] [--no-live-install]
```

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
  - SSH in from the host's address is the one other thing allowed, and pf's state lets only that
    session's replies out.
  - There is no DNS, no egress and no route to production.
- **`host-provision.sh`** runs on the host.
  - By default it only prints the `tart clone`, `tart set` and `tart run` commands.
  - It runs them only with **both** `--execute` and `SOAK_OPERATOR_APPROVED=1`.
  - It refuses to reuse an existing VM of the same name: a certification starts from a pristine guest,
    and deleting one is the operator's call.
  - The shared directory is the only host path the guest sees, read-write, so it must be a dedicated
    one. The script compares real paths, following symlinks and `..`. It refuses `/`, `$HOME`, any
    directory that contains `$HOME` (such as `/Users`), a relative path, and a directory that does not
    exist.
- **`guest-setup.sh`** runs inside the guest, from a checkout of the pinned release candidate, once that
  TangleClaw is answering on loopback.
  - It refuses to run where `TANGLECLAW_API` is set (a live pane), outside macOS, or on a machine that
    is not a VM (`kern.hv_vmm_present`).
  - It loads the pf profile, then **proves it holds**, because a profile that loaded but does not block
    is not isolation. Any failure or ambiguity stops it (exit 3) before anything else runs:
    - pf must report `Enabled`;
    - the rules pf reports must be exactly the profile's, in pfctl's own form;
    - `lo0` must be skipped;
    - loopback must answer on `127.0.0.1` and `::1`, and so must the guest TangleClaw's `/api/health`;
    - nothing outside may answer: TCP to a literal IPv4 and a literal IPv6 address, and a DNS query over
      UDP sent straight to a resolver's address. None of it depends on DNS.
  - It installs `soak-stub` on `PATH` and its engine profile.
  - It runs `soak.js repos`.
  - It attaches each project through the guest TangleClaw's own API. With the guest's auth gate down,
    it uses the dashboard client header. With the gate up, it refuses and tells you to attach from the
    dashboard. It never reads or writes a token.
  - Every step is safe to repeat.
  - **`guest-setup.sh --verify-network` only re-proves the network boundary.** It doesn't reload pf,
    because reloading would hide a pf that had been turned off. The soak runner must run it during and
    at the end of a run (that runner is a later chunk).

**Known limits of the isolation.** The boundary is pf inside the guest. `tart run` uses tart's default
network: nothing on the host side restricts the guest.
- **Anything in the guest with sudo can turn pf off.** The Cirrus Labs base images give the admin user
  passwordless sudo. The runbook must remove that, or run the soak workload as a user without admin
  rights, before certification begins.
- **pf rules do not survive a guest reboot.** Run `guest-setup.sh` again after any reboot. It is
  idempotent.
- **Setup proves isolation once.** Isolation during and at the end of the run is proven only when the
  runner calls `--verify-network`.
- **The profile also blocks DHCP.** If the guest's address lease expires during a 72-hour run, the
  operator may lose SSH to it. The soak itself runs on loopback and is unaffected. The dry run should
  show whether this happens.
- **Host-side restriction is not used yet.** Tart's softnet options could add a second layer. They are
  not used until an operator checks them against the installed tart.

The dry run and the certifying run then drive the guest's own TangleClaw from inside the guest, with
`run --no-live-install`.
