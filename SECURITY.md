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

### User Authentication (AUTH-2, #1420)

**A new install is protected out of the box.** It binds **loopback only** — nothing off the machine can reach it — until an operator explicitly opts into wider binding, and setup forces an admin login whenever the machine can actually enforce one. The two together are the posture: never reachable-and-unauthenticated. If ingress provisioning fails, setup lands in the loopback-only state and says so, rather than completing a network-reachable install with no password. (Earlier versions defaulted to no authentication and a wide bind; that opt-in posture is superseded — see `docs/adr/0009-secure-by-default.md`.)

**The gate is TangleClaw's own login**: accounts with scrypt-hashed passwords and a session cookie, enforced by the server on every surface — HTTP API, all three WebSocket routes, ttyd, and the proxied gateway — on every ingress mode. `/api/health` and `/manifest.json` stay public. Local machine clients on the loopback listener (the `tc` CLI, PortHub, the switchboard) are outside it; the optional service-token gate below covers them. Its state decides what a signed-out person meets (`lib/auth-gate.js`, ADR 0016):

- `armed` — an enabled account exists; the sign-in page.
- `account-required` — no account yet; the first-account page. Caddy's `basic_auth` stays in front of it in caddy mode, because whoever reaches that page claims the install.
- `locked` — accounts exist and every one is disabled; closed, recovered at the terminal.
- `unreadable` — the config or the account store could not be read; closed. A read failure never opens the gate.
- `fallback` — the operator's terminal fallback put Caddy's `basic_auth` back in front and TangleClaw stands down behind it, honoured only while the Caddyfile provably gates every route to TangleClaw and TangleClaw listens on loopback.
- `open` — `authEnabled` is off: the deliberate opt-out. In caddy mode it does not open an install whose Caddyfile serves other machines with no password of its own.

In caddy mode **Caddy's `basic_auth` is written only while it is needed**: whenever a Caddy credential is configured and TangleClaw's login does not guard the door by itself — so in `account-required`, in `fallback`, and when the gate state could not be read — and dropped once it does (`armed`, `locked`). A Caddy site written without `basic_auth` and not guarded by TangleClaw's login refuses every connection that is not from this machine. Properties:

- **No default credentials, ever.** The first-run wizard or the first-account page creates the first account; setup cannot complete without a login where one can be enforced. A shipped default credential with a change-me prompt was considered and rejected: this repository is public, so the default would be readable by anyone and every install pre-compromised until the operator acted.
- **Password rules:** minimum 12 characters, a bundled weak-password denylist, no-username-match, no control characters — the same rules on every surface that sets a password.
- **Sessions:** the cookie token is stored only as a digest; resetting an account's password ends all of its live sessions immediately, and signing out ends that browser's. There is not yet a command to disable an account (#1458); the store's disable verb also ends its sessions, and `locked` is reachable today only by editing the database. Sign-in verifications run asynchronously under a small concurrency cap, and every failure mode (no account, wrong password, disabled account) costs the same and answers the same.
- **Caddy's password, while it stands in front**, can be changed from global settings → **Caddy password** (`POST /api/auth/credential`), and only there or from the terminal tool. That route may **change** it, never create or blank one, and refuses unless Caddy's gate is live and the request arrived on loopback. Only the bcrypt hash is stored (`basicAuthHash`), produced by a `caddy hash-password` shell-out with the plaintext on stdin. `PATCH /api/config` refuses credential fields outright.
- **No permanent lockout.** A forgotten account password is reset with a **one-time recovery code** from the sign-in page (ADR 0009 rule 5 as amended): each code resets one account's password once, is stored only as a digest, and is issued when the account is created on the first-account page or regenerated in Settings with the current password. A redemption ends the account's other sessions and raises a dashboard notice; a wrong and a used code get the same answer, failures are rate-limited per client, and a code never re-enables a disabled account. At the terminal, `scripts/reset-admin.js --store --user <name>` creates, resets or re-enables an account, ends its sessions and deletes its recovery codes. A broken login is recovered from a shell with `scripts/gate-fallback.js`. [docs/recovery.md](docs/recovery.md) walks through each case.
- **Identity attribution.** "Logged in as ⟨user⟩" and each launched session's `owner` come from TangleClaw's own login session, on every ingress mode. TangleClaw does **not** trust an `X-Auth-User` header on any mode: it is deleted from every request (HTTP and WebSocket) as it arrives, so it never becomes identity and never reaches a terminal or gateway (#1420, ADR 0016 OQ2). A Caddyfile generated before #1420 still sends one; it is dropped like any other. This is attribution, not enforcement: actions are not yet restricted per user.

**Limitations:** no second factor, and no per-user permissions — every account can do everything. While Caddy's `basic_auth` stands in front, it has no server-side logout (the browser caches the credential until closed). Any login is only as strong as its transport — always pair it with HTTPS or a private tunnel, never plain HTTP on a network you do not control.

**Recommendation:** Run on a private network or behind a VPN (Tailscale, WireGuard). Keep the login in place for any non-localhost exposure — it is what a default install gives you, and turning it off is a deliberate act. Direct exposure to the public internet is **unsupported**: a password login with no second factor and no per-address lockout, in front of a surface that launches shells.

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

TangleClaw supports TLS via `httpsEnabled`, `httpsCertPath`, and `httpsKeyPath` in config (direct mode). HTTPS is required for OpenClaw Web UI device pairing from non-localhost browsers (secure context requirement). In **caddy ingress mode** (AUTH-1, ADR 0003), Caddy terminates TLS at a single ingress (mkcert for `localhost`, ACME for a configured `publicDomain`) and is the only path to the server; ttyd moves to a Unix socket unreachable except via the proxy chain. Caddy's `basic_auth`, in the states the login above still needs it, lives in this ingress.

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
