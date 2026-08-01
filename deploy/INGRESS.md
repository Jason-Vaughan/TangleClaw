# Ingress modes (AUTH-1, #395)

TangleClaw can run its ingress two ways, switched by the `ingressMode` config
flag (default `direct`). The switch is **reversible** — `direct` mode is exactly
the historical behavior.

| | `direct` (default) | `caddy` |
|---|---|---|
| TLS terminated by | TC itself (mkcert via `lib/https-setup.js`) | **Caddy** |
| TC listener | `127.0.0.1`, HTTPS (all interfaces only if `bindAllInterfaces`) | `127.0.0.1`, plain HTTP (Caddy fronts it) |
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

## Why setup runs the cutover as a detached child (#710)

The setup wizard provisions this ingress itself, and it does so by spawning
`scripts/ingress-cutover.js` as a **detached** child rather than executing the plan
in-process. That is not a style choice — it is the only shape that works, and the
reasoning belongs here rather than in a build plan that gets deleted:

`planCutover`'s launchctl sequence ends with `kickstart -k` on
`com.tangleclaw.server`. The cutover **restarts TangleClaw**, which it must, so the
server re-binds plain HTTP behind the new ingress. A request handler that ran the
same plan would therefore kill itself partway through: no response to the browser,
no health poll, and no way to report whether provisioning worked. The degraded
fallback the whole feature depends on is unimplementable in that shape, because the
process that must report the failure is the one that dies.

Two consequences fall out of the same fact:

- **The outcome must be persisted, not returned.** Hence `--result-file`: a JSON
  outcome with a stable `code`, written by every exit *after the run begins* —
  refusals included — so an absent file legibly means "died before finishing". The
  server reads it back at `GET /api/setup/provision-status`.
- **The child's stdout/stderr must go somewhere.** They are appended to
  `~/.tangleclaw/logs/ingress-cutover.log`. Discarding them would throw away the
  cutover's own "could not write result file" warning — the diagnostic that matters
  precisely when the result channel is the thing that failed.

Alternatives rejected, recorded so they are not re-proposed: executing the plan
in-process minus the kickstart leaves the server bound wrong until some later
restart and forks a security-critical executor into two implementations; deferring
the cutover to the next boot means the wizard cannot report success at all.

**The outcome is often unobservable from the page that started it**, and that is
expected rather than a bug. The cutover does not move TangleClaw's listen port, but
it does change the protocol and the interface (plain HTTP, loopback), so the
wizard's origin survives only when it was already `http://localhost:<port>`. From a
LAN or tailnet address, or over direct HTTPS, that origin closes at the restart and
the new perimeter address is a different port — cross-origin, where a probe cannot
read a status and probing a `basic_auth` URL pops the browser's own credential
prompt. The wizard therefore ends on an explicit "cannot confirm" screen naming the
login prompt as the check that settles it. Do not "fix" that by assuming success.

## Credential durability (#397, added after the 2026-07-03 lockout)

The `basic_auth` credential is canonical in **config** (`basicAuthUser` +
`basicAuthHash` in `~/.tangleclaw/config.json`), never only in the Caddyfile:

- **Boot-time adoption** — in caddy mode, if the live Caddyfile carries a
  credential the config doesn't, the server adopts it into config at startup
  (read-only on the Caddyfile). A hand-maintained gate becomes durable
  automatically on the next boot.
- **Byte-for-byte re-emission** — every regeneration path (cutover,
  `reset-admin`) emits the stored hash exactly; regression-tested.
- **Three writers, one sequence** — the cutover, `reset-admin.js`, and
  `POST /api/auth/credential` (global settings → Login) are the only things that
  change a credential. The latter two share one implementation,
  `lib/admin-credential.js applyCredentialChange`: patch the live Caddyfile,
  `caddy validate` fail-closed restoring the original, only then record it in
  config, then reload. `PATCH /api/config` refuses credential fields outright.
  The settings route may **change** a login and never create or blank one — it
  requires a live gate, which is what authenticates the request; creating a first
  credential stays here, at a terminal, because a reset behind the gate cannot
  help someone the gate has locked out.
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

**The reload is a restart, and it drops connections.** `admin off` is set in both
the generated and the hand-edited Caddyfile, so Caddy's `localhost:2019` admin API
is unavailable and the graceful `caddy reload` path does not exist here — the reload
is `launchctl kickstart -k`. Anything arriving through Caddy (the dashboard, the
browser terminal, a proxied OpenClaw UI) is interrupted while it comes back.

**Verified live on 2026-08-01** against this machine's hand-edited Caddyfile, which is
what moved break-glass from "built and unit-tested" to proven: the reload executed on
the real LaunchAgent (PID changed, exit 0), the gate re-authenticated on the new
credential, config and the live file stayed in agreement, and the file came out
**byte-identical apart from the hash** — still classified `adoptable`/`safeToWrite:
false`, so the cutover's clobber-guard keeps protecting it. Two operational facts came
out of that run and are worth knowing before you need this tool:

- **It enforces the CURRENT password policy, so a credential predating the policy
  cannot be restored as-is.** The rules (≥12 chars, not a common password, must not
  contain the username) apply to whatever you type, including the password already in
  force. An operator reaching for break-glass intending to reinstate a password they
  know may be refused and forced to choose a new one mid-incident. Correct behaviour —
  a recovery path that installs a weak credential undermines the mandatory gate — but
  decide and record the new password *before* starting, because the disconnect follows
  within seconds.
- **"Run it under tmux" is not sufficient guidance when the operator arrives through
  ttyd.** That terminal is already tmux-backed (so the process does survive the drop),
  but its window may be running an AI session rather than a shell. Open a second window
  (`Ctrl-b c`) and run it there; `tmux new -s <name>` from inside fails as a nested or
  duplicate session.

### Creating a gate where there is none

An install that reached `setupComplete` before a credential was mandatory and then
moved to caddy mode has no `basic_auth` line to patch, and every other route out of
that state refuses it. `reset-admin.js` builds one:

```bash
node scripts/reset-admin.js --create-gate --user <name>
```

This rebuilds the Caddyfile **from its own current settings** — ports, upstream and
certificate are read back out of the file rather than out of `config`, so the result
differs from what was there by exactly the gate, and config drift cannot ride along.

It refuses far more than it accepts, and each refusal names its own remedy:

| Refusal | Meaning | What to do |
|---|---|---|
| `not-caddy-mode` | The install is not in caddy ingress mode, so nothing would enforce a gate written into this file. A Caddyfile left behind by `--to direct` is a file, not a live gate. | `ingress-cutover.js --to caddy` first |
| `gate-exists` | A credential is already present. | Use the ordinary reset above |
| `not-generated` | The Caddyfile is hand-maintained. **Refused, not reshaped** — adding a gate means placing directives inside site blocks this code did not write, and guessing wrong either drops your configuration or leaves an opening that looks closed. | Add the `basic_auth` block by hand, then reset |
| `unrecognized-shape` | The file is TangleClaw-generated but the ungated rebuild does not reproduce it byte-for-byte, so something in it would be silently dropped. **A `publicDomain` ACME site is the common case** — see the section below. | `ingress-cutover.js`, which builds from your full config |

The last one exists because rebuilding from a handful of recovered fields can only
preserve what those fields model. The check is a round-trip rather than a field list,
so it also covers whatever option the generator gains next.

Run `--dry-run --create-gate --user <name>` first: the preview asks the identical
predicate, so it reports the refusal you would actually get rather than describing a
rebuild that will not happen.

**Undoing a gate created with the wrong username.** There is no rename path — the
ordinary reset refuses one (`rename-unsupported`, because the underlying replace
writes back the *matched* username, so a "successful" rename would leave the gate on
the old name while config recorded the new one), and a second `--create-gate` refuses
with `gate-exists`. Restore the timestamped backup the run printed, then create again:

```bash
cp ~/.tangleclaw/Caddyfile.<stamp>.credential.bak ~/.tangleclaw/Caddyfile
caddy validate --config ~/.tangleclaw/Caddyfile --adapter caddyfile
node scripts/reset-admin.js --create-gate --user <correct-name>
```

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
