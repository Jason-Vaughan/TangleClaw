# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in TangleClaw, please report it responsibly:

**Email:** Open a private issue on GitHub or contact the maintainer directly.

Do **not** open a public issue for security vulnerabilities.

## What's in Scope

- Authentication and authorization bypass
- Command injection via API endpoints
- Path traversal in file upload or config handling
- Cross-site scripting (XSS) in the web UI
- SSH tunnel or proxy misconfiguration that leaks data
- Token or credential exposure

## Security Model

TangleClaw is designed to run on a **trusted local network or VPN** — it is not a hardened internet-facing service. The security model reflects this:

### User Authentication (optional gate, AUTH-2)

By default TangleClaw does **not** authenticate users — anyone who can reach the server port can view projects and open terminal sessions. This default suits local-only use. The `deletePassword` config option protects destructive operations (project deletion, session kill/wrap) but does not gate read access.

For remote / VPN-reachable installs, an **optional login gate** is available in caddy ingress mode (see "HTTPS / Ingress" below). When enabled (`authEnabled`), Caddy's built-in `basic_auth` fronts **every** surface at the single ingress — HTTP API, all three WebSocket routes, ttyd, and the proxied gateway — while leaving `/api/health` public for liveness probes. Properties:

- **No default credentials.** The first-run wizard forces a blocking admin-creation step in caddy mode; setup cannot complete without an admin (`ADMIN_REQUIRED`).
- **Password rules:** minimum 12 characters, a bundled weak-password denylist, no-username-match, no control characters.
- **Hash storage:** only the bcrypt hash is stored (in `config.json` as `basicAuthHash`), produced by a `caddy hash-password` shell-out — the plaintext is passed on stdin and never logged, stored, or placed on a command line.
- **No permanent lockout.** A lost admin password is recoverable from a terminal on the host via `scripts/reset-admin.js` (fail-closed; preserves a hand-edited Caddyfile). Recovery requires physical/SSH access by design — it opens no network reset path.
- **Single admin, no MFA** in this version. A multi-user / portal / MFA upgrade (caddy-security) is documented but deferred (ADR 0004).
- **Identity attribution (AUTH-3).** When the gate is live, Caddy forwards the authenticated username to TC (`header_up X-Auth-User {http.auth.user.id}`); TC shows "Logged in as ⟨user⟩" and records it as each launched session's `owner`. TC trusts `X-Auth-User` **only** in caddy-ingress + `authEnabled` mode — in direct mode the header is ignored, so it cannot be forged against TC's localhost listener. This is attribution, not enforcement: actions are not yet restricted per user (single operator).

**Limitations:** HTTP Basic Auth has no server-side logout (the browser caches the credential until closed) and is a single shared identity. The gate is only as strong as the transport — always pair it with HTTPS, never plain HTTP.

**Recommendation:** Run on a private network or behind a VPN (Tailscale, WireGuard) **and** enable the auth gate for any non-localhost exposure. Do not expose to the public internet without both.

### Service Tokens — M2M API gate (optional, AUTH-4)

The AUTH-2 gate protects **remote** callers at the Caddy ingress, but TangleClaw's own fleet (every project's session, registering ports and syncing shared docs) calls back into the API on the **direct localhost listener** (`localhost:3102`), which Caddy does not front. By default those two surfaces are unauthenticated:

- **PortHub** — `/api/ports*` (lease, release, heartbeat, sync, list)
- **Shared-docs** — `/api/shared-docs*` and a group's `/api/groups/:id/sync`

An **optional bearer-token gate** (`serviceTokenEnabled`, default `false`) closes that path. Properties:

- **Single fleet token.** One `tcsk_`-prefixed token (`tcsk_` + 32 bytes base64url, generated with `node:crypto`) authorizes both surfaces for every project. Per-project / per-surface scopes are deferred (AUTH-5+); per-session *attribution* is already provided by AUTH-3's `sessions.owner`.
- **Auto-generated on enable; reveal/rotate in Settings.** Enabling the gate auto-generates the token; the Settings "Service Token (M2M API)" panel reveals it (`GET /api/service-token`) and rotates it (`POST /api/service-token/rotate`). No first-run wizard step. The management endpoints sit **outside** the gated set, so a service caller can't reveal or rotate its own credential.
- **Raw at rest, redacted from the config API.** The token is stored raw in `config.json` (`serviceToken`) — it must be, because TC auto-injects it into each project's generated config guide, and a hash can't be injected. It is consistent with the existing `audit_secret` / gateway / bridge raw-at-rest secrets and is redacted from `GET`/`PATCH /api/config` (a `serviceTokenConfigured` boolean is surfaced instead).
- **Constant-time comparison** (`crypto.timingSafeEqual`); **fail-closed** when enabled with no token (`500 SERVICE_TOKEN_MISCONFIGURED`, only reachable by hand-editing `config.json`); a missing/wrong `Authorization: Bearer` header returns `401`.
- **Default-off and reversible.** When off the gate is a no-op and the surfaces behave byte-for-byte as before; disabling restores open behavior exactly. Decoupled from `ingressMode`/`authEnabled` — it protects the localhost path in both direct and caddy mode.

**Limit (no over-claiming):** a fully-compromised local user who can read `~/.tangleclaw/config.json` or a project's generated config can read the token. This gate is attribution and lateral-movement friction on a single-tenant box — **not** a defense against a root-equivalent local attacker. Rotating a token invalidates the old one; live sessions holding it lose API access until they relaunch and re-acquire the injected value. See ADR 0005.

### HTTPS / Ingress

TangleClaw supports TLS via `httpsEnabled`, `httpsCertPath`, and `httpsKeyPath` in config (direct mode). HTTPS is required for OpenClaw Web UI device pairing from non-localhost browsers (secure context requirement). In **caddy ingress mode** (AUTH-1, ADR 0003), Caddy terminates TLS at a single ingress (mkcert for `localhost`, ACME for a configured `publicDomain`) and is the only path to the server; ttyd moves to a Unix socket unreachable except via the proxy chain. The optional auth gate above lives in this ingress.

### Password Storage

The `deletePassword` is hashed with scrypt before storage. Plaintext passwords from older versions are auto-upgraded on first verification.

### Gateway and Bridge Tokens

OpenClaw gateway tokens and ClawBridge tokens are stored in the SQLite database as plaintext. These tokens authenticate TangleClaw to remote services, not users to TangleClaw. Treat the database file (`~/.tangleclaw/tangleclaw.db`) as sensitive.

### SSH Key References

TangleClaw stores SSH key file paths (not key contents) in the database for OpenClaw connections. The keys themselves remain on disk and are used by the SSH tunnel manager.

### File Uploads

Uploads are restricted by:
- File extension allowlist (images, docs, configs only)
- 15 MB size limit
- Timestamped filenames (no path traversal)

### Eval Audit Mode

When enabled, `ANTHROPIC_API_KEY` must be set as an environment variable. This key is used for Tier 2/3 judge scoring calls and is never stored in the database or logged.

## Supported Versions

Security fixes are applied to the latest release only.
