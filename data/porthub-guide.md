## Port Management (PortHub)

TangleClaw is the central port registry for every project on this machine — register each port here to prevent conflicts. (This replaces the old standalone `porthub` CLI: use the TangleClaw API, not `porthub lease`/`porthub release`.)

### Rules
- **Never hardcode ports** — check and register through TangleClaw first.
- **Register before binding** to a port (dev server, database, API, etc.).
- **Check for conflicts** before claiming a port — another project may already own it. The
  registry now enforces this: claiming a port another project holds returns **409**, it does
  not silently take it. On this machine it also asks the OS: a port with a listener that no
  lease records returns **409 `PORT_IN_USE`** naming the process.
- **Send `host`** when the service is not on this machine. Leases are keyed on `(host, port)`,
  every route defaults `host` to `localhost`, and the same port number can belong to different projects
  on different hosts.
- **Release** a port once it's no longer needed (service stopped, teardown, cleanup).
- **Declare `reach`** when the service is meant to be reachable beyond loopback. A service that
  binds `127.0.0.1` is already stating its intent; `reach` is where another process can read it.
  TangleClaw's Caddyfile divergence check cross-references it, so a proxy fronting a port whose
  owner meant it to stay local is reported rather than silently accepted. A lease with no `reach`
  is treated as `loopback` and never as permission to expose the port.

### Port Ranges Convention
- **3100-3199**: TangleClaw infrastructure (ttyd, server) — do not use
- **3200-3999**: Project services (dev servers, APIs, databases)
- **4000-4999**: Auxiliary services (test runners, watchers)
- **5000+**: Ad hoc / temporary

### Authentication

When the operator has enabled the M2M service-token gate (AUTH-4), every `/api/ports*` call needs `Authorization: Bearer <token>` (else `401`). Where this guide sits in a file the project COMMITS, the live token is deliberately not beside it — fetch it from `$TANGLECLAW_API/api/service-token` (#1619). In an engine-private config TC still injects the header with the live token below this guide. Off by default (no token needed). Rotating the token invalidates the old one — relaunch to pick up the new value.

### API Operations

All calls are JSON. In an engine-private config the API base URL is injected **below this guide**; in a committed carrier it is not written at all — read `$TANGLECLAW_API`, which your launch exported (#1619). Either way use it as-is: its scheme already reflects what the server serves (plain `http://` under `ingressMode: caddy` or with no certificates, else `https://`; don't "upgrade" it). For a mkcert `https://` URL, pass `curl -k` or trust the mkcert root CA.

```
# Check what's taken (before picking a port)
GET /api/ports

# Register a port. Pass "permanent": true to survive restarts (the default over
# HTTP is false — an omitted flag gives you a non-permanent lease).
# "reach" declares how far the service is MEANT to be reachable —
# "loopback" (default) | "tailnet" | "lan". Omitting it means loopback on EVERY
# write, renewals included, so restate a wider reach each time you re-register.
# Returns 201 on success, or 409 if another project already holds the port or an
# unleased process is listening on it. Already started the service yourself? Add
# "adoptListener": true to say the listener is yours.
# "ownerKind": "external" records an owner that is not a TangleClaw project (a
# brew services database); an omitted ownerKind keeps whatever the lease had.
POST /api/ports/lease
{ "port": 3200, "host": "localhost", "project": "my-project", "service": "dev-server", "permanent": true, "reach": "loopback" }

# Register a temporary port (expires after TTL unless heartbeated)
POST /api/ports/lease
{ "port": 4000, "project": "my-project", "service": "test-runner", "ttl": 7200000 }

# Release a port when done. Always send your own "project": ownership is verified
# when present — releasing a port a DIFFERENT project still holds returns 409
# (add "force": true to override). Omitting "project" skips the check. Omitting
# "host" means localhost, and is refused with 400 HOST_REQUIRED when another host
# also leases that port.
POST /api/ports/release
{ "port": 3200, "host": "localhost", "project": "my-project" }

# Heartbeat to keep a TTL lease alive. Send "project" too: renewing another
# project's lease returns 409.
POST /api/ports/heartbeat
{ "port": 4000, "host": "localhost", "project": "my-project" }
```

### When to Register / Release
- **Register** when adding any listening service (dev server, database, API) to a project, or spinning up a temporary test server.
- **Release** when removing a service from a project's config, permanently shutting one down (not just a temporary stop), or when the project no longer needs the port.

### Conflict Resolution

Claiming a port another project holds returns **409** with the current owner:

```json
{ "error": "Port 3200 on localhost is leased by \"other-project\" (dev-server). …",
  "code": "PORT_CONFLICT",
  "owner": { "project": "other-project", "service": "dev-server", "permanent": true } }
```

**Pick a different port in the same range.** That is the answer in almost every case — the
owner in the response tells you who has it without a second call.

A port with a listener but no lease returns **409** `PORT_IN_USE` with the process instead of
an owner (`"listener": { "port", "pid", "command" }`). The same rule applies: pick another
port, unless that listener is your own service, in which case repeat with
`"adoptListener": true`. That flag is separate from `force`, which takes over another project's
lease. `GET /api/ports` lists these unleased listeners as `systemPorts`. A 201 carries
`listenerCheck`, which says what the check found: `clear`, `adopted`, `renewal`, `takeover`,
`not-local` (another host, which this machine cannot see), or `unavailable` (lsof could not run,
so the port was granted unchecked).

Re-leasing a port **your own project** already holds is a renewal, not a conflict: it
succeeds normally, so idempotent re-registration on every boot needs no special handling.
An **expired** lease does not block anyone.

Taking over a live lease requires `"force": true` in the body. It is deliberately explicit
and it is logged with the displaced owner, because the displaced project is still running
against a port the registry no longer says is theirs. Use it only when you know the previous
owner is gone — otherwise release the port from the owning side first.

**Scope of enforcement, precisely.** `lease` is guarded. `release` and `heartbeat` are guarded
**when you name your project** (#656): a mismatch returns 409 with the current owner, just like
`lease`. The check is opt-in because these calls historically took only a port — a request that
omits `project` still releases or renews unverified, so the guarantee holds only for callers that
send their own project (always do). This closes the accidental case — an agent cleaning up after
itself no longer silently releases a neighbor's live port — but it is not authentication: nothing
binds the caller to the project name it sends, so a caller that supplies someone else's project
can still act on their lease. Treat release as the destructive call it is: send your `project`,
and release only ports your own project holds.

