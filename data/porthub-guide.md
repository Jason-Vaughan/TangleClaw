## Port Management (PortHub)

TangleClaw is the central port registry for all projects on this machine. Every port used by any project must be registered here to prevent conflicts. This replaces the old standalone `porthub` CLI — do not use `porthub lease`/`porthub release`; use the TangleClaw API instead.

### Rules
- **Never hardcode ports.** Always check and register through TangleClaw first.
- **Always register a port** before binding to it (dev server, database, API, etc.).
- **Release ports** when they are no longer needed (service stopped, project teardown, cleanup).
- **Check for conflicts** before claiming a new port — another project may already own it.

### Port Ranges Convention
- **3100-3199**: TangleClaw infrastructure (ttyd, server) — do not use
- **3200-3999**: Project services (dev servers, APIs, databases)
- **4000-4999**: Auxiliary services (test runners, watchers)
- **5000+**: Ad hoc / temporary

### API Operations

All calls are JSON. Use `curl` or equivalent. The TangleClaw API base URL is injected below this guide. HTTPS (`https://localhost:3102`) is the default; installs that skipped HTTPS or have no certificates configured fall back to `http://localhost:3102`. When hitting HTTPS with a locally generated certificate (mkcert), pass `-k` to `curl` or install the mkcert root CA so the client trusts it.

**Check what's taken** before picking a port:
```
GET /api/ports
```

**Register a port** (permanent by default — survives restarts):
```
POST /api/ports/lease
{ "port": 3200, "project": "my-project", "service": "dev-server", "permanent": true }
```

**Register a temporary port** (expires after TTL unless heartbeated):
```
POST /api/ports/lease
{ "port": 4000, "project": "my-project", "service": "test-runner", "ttl": 7200000 }
```

**Release a port** when you're done with it:
```
POST /api/ports/release
{ "port": 3200 }
```

**Heartbeat** to keep a TTL lease alive:
```
POST /api/ports/heartbeat
{ "port": 4000 }
```

### When to Register
- Setting up a dev server, database, or any service that listens on a port
- Adding a new service to an existing project
- Spinning up a temporary test server

### When to Release
- Removing a service from a project's config
- Shutting down a dev server permanently (not just stopping it temporarily)
- Project no longer needs that port

### Conflict Resolution
If `GET /api/ports` shows a port is taken, pick a different one in the same range. Do not overwrite another project's lease.
