## Port Management (PortHub)

TangleClaw manages port assignments for all projects. Follow these rules:

### Rules
- **Never hardcode ports.** Always register them through TangleClaw.
- **Always register ports** before using them in your project.
- **Release ports** when they are no longer needed (e.g., project teardown).
- **Check for conflicts** before claiming a new port.

### Port Ranges Convention
- **3100-3199**: TangleClaw infrastructure (ttyd, server)
- **3200-3999**: Project services (dev servers, APIs, databases)
- **4000-4999**: Auxiliary services (test runners, watchers)
- **5000+**: Ad hoc / temporary

### How It Works
TangleClaw stores port leases in its SQLite database. Leases can be:
- **Permanent**: Survive restarts, no expiration (used for infrastructure)
- **TTL-based**: Expire after a duration unless heartbeated (used for temporary services)

### Common Operations
- Register a port: Use the TangleClaw API `POST /api/ports/lease`
- Release a port: Use `POST /api/ports/release`
- Check all leases: Use `GET /api/ports`
- Heartbeat a TTL lease: Use `POST /api/ports/heartbeat`

### When to Register/Release
- **Register** when starting a new service, dev server, or background process that binds a port.
- **Release** when stopping a service, deleting a project, or during cleanup.
- **Heartbeat** periodically for TTL-based leases to prevent automatic expiration.
