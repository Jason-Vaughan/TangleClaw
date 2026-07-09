## Port Management (PortHub)

TangleClaw is the central port registry for every project on this machine — register each port here to prevent conflicts. (This replaces the old standalone `porthub` CLI: use the TangleClaw API, not `porthub lease`/`porthub release`.)

### Rules
- **Never hardcode ports** — check and register through TangleClaw first.
- **Register before binding** to a port (dev server, database, API, etc.).
- **Check for conflicts** before claiming a port — another project may already own it.
- **Release** a port once it's no longer needed (service stopped, teardown, cleanup).

### Port Ranges Convention
- **3100-3199**: TangleClaw infrastructure (ttyd, server) — do not use
- **3200-3999**: Project services (dev servers, APIs, databases)
- **4000-4999**: Auxiliary services (test runners, watchers)
- **5000+**: Ad hoc / temporary

### Authentication

When the operator has enabled the M2M service-token gate (AUTH-4), every `/api/ports*` call needs `Authorization: Bearer <token>` (else `401`). TC injects the header with the live token below this guide — copy it onto each request. Off by default (no token needed). Rotating the token invalidates the old one — relaunch to pick up the new value.

### API Operations

All calls are JSON. The API base URL is injected **below this guide**; use it as-is — its scheme already reflects what the server serves (plain `http://` under `ingressMode: caddy` or with no certificates, else `https://`; don't "upgrade" it). For a mkcert `https://` URL, pass `curl -k` or trust the mkcert root CA.

```
# Check what's taken (before picking a port)
GET /api/ports

# Register a port (permanent by default — survives restarts)
POST /api/ports/lease
{ "port": 3200, "project": "my-project", "service": "dev-server", "permanent": true }

# Register a temporary port (expires after TTL unless heartbeated)
POST /api/ports/lease
{ "port": 4000, "project": "my-project", "service": "test-runner", "ttl": 7200000 }

# Release a port when done
POST /api/ports/release
{ "port": 3200 }

# Heartbeat to keep a TTL lease alive
POST /api/ports/heartbeat
{ "port": 4000 }
```

### When to Register / Release
- **Register** when adding any listening service (dev server, database, API) to a project, or spinning up a temporary test server.
- **Release** when removing a service from a project's config, permanently shutting one down (not just a temporary stop), or when the project no longer needs the port.

### Conflict Resolution
If `GET /api/ports` shows a port is taken, pick a different one in the same range — never overwrite another project's lease.
