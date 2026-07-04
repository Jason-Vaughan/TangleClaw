# Ingress modes (AUTH-1, #395)

TangleClaw can run its ingress two ways, switched by the `ingressMode` config
flag (default `direct`). The switch is **reversible** — `direct` mode is exactly
the historical behavior.

| | `direct` (default) | `caddy` |
|---|---|---|
| TLS terminated by | TC itself (mkcert via `lib/https-setup.js`) | **Caddy** |
| TC listener | all interfaces, HTTPS | `127.0.0.1`, plain HTTP (Caddy fronts it) |
| ttyd bind | TCP `:3100` | Unix socket `~/.tangleclaw/run/ttyd.sock` |
| single ingress | no | yes — Caddy is the only path |
| local URL | `https://localhost:3102` | `https://localhost:8443` |

`caddy` mode is the prerequisite for the AUTH-2 forward-auth gate (a single
chokepoint in front of the HTTP API, WebSockets, ttyd, and the proxied gateway).
AUTH-1 adds **no authentication** — only the ingress.

## Activate / roll back (macOS)

```sh
# one-time: install the Caddy binary
brew install caddy

# activate Caddy ingress (reversible)
node scripts/ingress-cutover.js --to caddy

# preview without touching anything
node scripts/ingress-cutover.js --to caddy --dry-run

# roll back to direct HTTPS (exactly today's behavior)
node scripts/ingress-cutover.js --to direct      # or: --rollback
```

The cutover is **fail-closed**: it `caddy validate`s the generated Caddyfile
before any launchd reload, so a bad config never takes the ingress down. It
regenerates the ttyd plist for the target transport, flips `ingressMode`, reloads
the affected launchd jobs, restarts the TC server so its listener re-binds, and
health-checks. Caddy runs as a **user LaunchAgent** (`com.tangleclaw.caddy`) — no
sudo — because it listens on the non-privileged `caddyHttpsPort`/`caddyHttpPort`
(default `8443`/`8080`). Caddy's local CA + ACME material live under
`~/.tangleclaw/caddy/`.

The local site reuses your existing mkcert certificate, so local HTTPS is
unchanged (same already-trusted CA). Set `publicDomain` in config to also emit an
ACME (Let's Encrypt) site block for a real domain.

## Credential durability (#397, added after the 2026-07-03 lockout)

The `basic_auth` credential is canonical in **config** (`basicAuthUser` +
`basicAuthHash` in `~/.tangleclaw/config.json`), never only in the Caddyfile:

- **Boot-time adoption** — in caddy mode, if the live Caddyfile carries a
  credential the config doesn't, the server adopts it into config at startup
  (read-only on the Caddyfile). A hand-maintained gate becomes durable
  automatically on the next boot.
- **Byte-for-byte re-emission** — every regeneration path (cutover,
  `reset-admin`) emits the stored hash exactly; regression-tested.
- **Refuse-to-ungate** — the cutover aborts rather than replace a gated
  Caddyfile with an ungated one when config carries no credential.
- **Remote plain-HTTP catch-all** — set `caddyRemoteHttp: true` (adopted
  automatically if the live file has an `http:// { ... }` site) to emit a
  Basic-Auth-gated plain-HTTP catch-all for WireGuard/Tailscale remote access,
  plus `auto_https disable_redirects`. The generator refuses to emit the
  catch-all without a credential — an ungated one would be an open door.

## Admin credential reset (break-glass, AUTH-2)

When the Caddy `basic_auth` gate is active (AUTH-2) and the admin password is lost,
recover it from a terminal **on the host** — the gate runs in Caddy locally, so
physical/SSH access to the box is always a sufficient recovery path (no working
remote login required):

```bash
node scripts/reset-admin.js --dry-run   # preview (user + steps), touches nothing
node scripts/reset-admin.js             # prompt for the new password (hidden, x2)
#   --user <name>        disambiguate when >1 admin user is in the Caddyfile
#   --password-stdin     read the new password from a pipe (scripting)
```

It patches the credential **in place** (it does not regenerate a hand-edited
Caddyfile), re-validates fail-closed (restoring a timestamped `.bak` if the patch
is invalid), reloads Caddy, and syncs the stored `basicAuthUser`/`basicAuthHash`
so a later cutover stays consistent. New passwords must be ≥12 chars, not a common
weak password, and must not contain the username. The machine-local
`~/.tangleclaw/EMERGENCY-RECOVERY.md` carries the full runbook + a manual fallback.

## Public domain on 443/80 (root LaunchDaemon)

Real Let's Encrypt issuance needs a public domain with ports 80/443 reachable
from the internet. To serve those privileged ports on macOS, Caddy must run as a
**root LaunchDaemon** rather than a user LaunchAgent:

1. Set `caddyHttpsPort: 443`, `caddyHttpPort: 80`, and `publicDomain` in config.
2. Move `com.tangleclaw.caddy.plist` to `/Library/LaunchDaemons/`, owned by root,
   and load it with `sudo launchctl bootstrap system …` (instead of the user
   `gui/<uid>` domain).
3. Point DNS at the host and ensure 80/443 are forwarded.

This is a documented manual path, not the default — the no-sudo `:8443` local
setup is what AUTH-1 ships and verifies. Live ACME verification is tracked as
`VRF-auth-1-cutover`.

## Linux / systemd (seam — not yet implemented)

The same shape is the standard Linux self-hosting layout and is intended to port
cleanly, but AUTH-1 implements only the macOS launchd path. A future chunk adds:

- systemd units `tangleclaw-caddy.service` + a socket-activated or `--interface`
  ttyd unit (replacing the launchd plists),
- the cutover orchestration behind a platform check (`launchctl` vs `systemctl`),
- `CAP_NET_BIND_SERVICE` (or a high port) instead of the macOS root-daemon dance
  for 443/80.

`lib/caddy.js` (Caddyfile generation/validation) and the `ingressMode` transport
logic in `server.js` are platform-agnostic and reused as-is; only the
process-manager glue (`scripts/ingress-cutover.js`, the plists) is macOS-specific
today.
