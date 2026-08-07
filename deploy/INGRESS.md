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
  precisely when the result channel is the thing that failed. The log is `0600`,
  rotates at 1 MB keeping one previous generation, and the credential hash that
  `caddy validate` can quote back is redacted at its producer (#821).

### If this machine ran a cutover before 2026-08-06, check its log once

Both #821 controls are **prospective**. Redaction scrubs text as it is written, and a
log below the rotation threshold never rotates — so a hash already sitting in
`~/.tangleclaw/logs/ingress-cutover.log` stays there indefinitely. Nothing in the fix
rewrites history, deliberately: silently truncating an operator's only record of what
setup did is not a call TangleClaw should make on its own.

It only happened if a cutover actually hit the validate-failure path (most installs
never do). Check, and clear it yourself if so:

```sh
grep -c '\$2[aby]\$' ~/.tangleclaw/logs/ingress-cutover.log        # 0 means nothing to do
grep -rl '\$2[aby]\$' ~/.tangleclaw/logs/ingress-cutover.log*      # includes rotated generations
```

If a match appears, the file is narration, not state — nothing reads it back, so it is
safe to remove: `rm ~/.tangleclaw/logs/ingress-cutover.log*`. Changing the password
itself is only warranted if that file left the machine (a pasted log, a bug report, a
backup), since the hash is bcrypt and `0600`.

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

## HTTP/1.1 pin on the HTTPS listener

The generated Caddyfile always pins the HTTPS listener to HTTP/1.1:

```
{
	servers :8443 {
		protocols h1
	}
}
```

**Why:** Chrome aborts terminal WebSockets client-side — close code 1006, the
request never reaches Caddy — whenever the TLS origin negotiates h2 or h3. Every
terminal WebSocket that has ever worked here ran over HTTP/1.1, and the
reconnect-loop incidents this prevents recurred three times in two weeks. Since
terminals are the product's primary surface, the pin is **unconditional** and has
no config flag: a setting that could omit it would regenerate a broken perimeter.

This is a workaround, not a root-cause fix — why Chrome aborts the upgrade under
h2/h3 is still unidentified. **Do not remove it as an unexplained setting.** The
port tracks `httpsPort`, so a custom port is pinned too. Plain HTTP needs no pin
(Caddy does not serve h2c unless explicitly asked).

### Checking and fixing an already-deployed Caddyfile

The generator emitting the pin does **not** retrofit a Caddyfile that is already on
disk — nothing rewrites a live Caddyfile except an operator-run cutover, and
`validateCaddyfile` checks syntax only. Any install created before the pin landed
is still unpinned. Check it:

```bash
# does the live HTTPS listener actually carry the pin?
# stderr is left ON: if this fails, the reason matters more than the output
caddy adapt --config ~/.tangleclaw/Caddyfile \
  | python3 -c 'import json,sys; s=json.load(sys.stdin)["apps"]["http"]["servers"]; [print(k, v.get("listen"), v.get("protocols")) for k,v in s.items()]'
```

Expected on a pinned install — the HTTPS listener reports `['h1']`, and the
plain-HTTP listener reporting `None` is correct, not a second problem:

```
srv0 [':8080'] None
srv1 [':8443'] ['h1']
```

If the HTTPS listener prints `None`, it is unpinned and Chrome terminals will
drop at 1006. If instead you get a Python traceback, `caddy adapt` itself failed —
read its error above the traceback (usually `caddy` not in PATH, or no Caddyfile
at that path); the check never ran.

**Which fix you want depends on whether your Caddyfile is still generator-pristine.**
Find out first — the answer decides the whole procedure:

```bash
node scripts/ingress-cutover.js --to caddy --dry-run
```

- **No "would REFUSE" line → your file is pristine.** Re-run the cutover without
  `--dry-run`. It regenerates from the generator, which now emits the pin, and it
  is **lossless**: a pristine file carries no hand edits to lose, by definition.
  Stop here — do **not** hand-edit. A generated Caddyfile carries a sha256 of its
  own body in the header, and any hand edit invalidates that stamp, after which
  every future cutover either refuses your file or needs the lossy `--force`.
  Hand-editing a healthy install is a one-way door.

- **"would REFUSE: … is hand-edited" → use the manual steps below.** The cutover
  will not overwrite your edits, and forcing past it with `--force` writes a
  timestamped backup but still replaces the file, discarding every other hand edit
  it carries (see the parity caveat below).

**Manual fix — hand-edited files only.** Add the block to the live file, then
restart Caddy. Caddyfile syntax requires the opening brace at end-of-line, so it
must be three lines — a one-line `servers :8443 { protocols h1 }` is a parse
error:

```
{
	https_port 8443
	http_port 8080
	admin off
	servers :8443 {
		protocols h1
	}
}
```

Add only the `servers` block, inside the existing top-level `{ … }` global
options block (the other directives above are shown for placement, not to be
retyped). **Match the port to your own `https_port`** — if that line says
something other than `8443`, the `servers :` line must say the same thing.

**Do not reach for `--force` to get past the refusal on a hand-edited file.** It
writes a timestamped backup but still replaces the file, discarding every other
hand edit it carries. For a hand-edited Caddyfile, regenerating is only safe once
the generator reproduces the live file in full — see the parity caveat below.

> **Access logging is deliberately NOT generator-owned (#846, decided 2026-08-03).**
> The generator emits no `log { … }` block under any option, so a cutover onto a
> Caddyfile that carries one by hand **ends Caddy access logging** — this is a real
> loss, and it is not a bug to be fixed by teaching the generator to emit one.
>
> The reason is that an ingress log is not free. As originally argued:
> `~/.tangleclaw/logs/ingress-cutover.log` itself grew without rotation and could capture a
> `basic_auth` credential hash (**#821**), so emitting an access-log block by default would
> propagate that hazard to every new install.
>
> **That premise no longer holds — #821 closed 2026-08-06.** The cutover log now rotates
> (1 MB, 2 files) and the hash is redacted at its producer. The nearest supporting
> argument for this decision is therefore gone, and it is recorded here rather than
> quietly dropped, because a decision whose stated reason has expired should be re-argued
> on purpose or not at all.
>
> **The decision stands on what is left of it**, which is narrower but still real: an
> access log is a file TangleClaw would be creating on a machine whose operator never
> asked for one, and *whoever emits a log owns its rotation* — which for a Caddy-written
> log is Caddy's `log` directive, not anything TangleClaw controls. A gap the operator
> opts into is safer than a hazard they inherit. Whether the closed #821 changes the
> balance enough to revisit #846 is a decision for the operator, not a side effect of
> this fix.
>
> **If you want access logging, add the block by hand and own its rotation** — see
> Caddy's `log` directive. Re-read this before any cutover on a machine that has one:
> back the block up first, and re-add it afterwards.
>
> **Audit generator/deployment parity by *diffing* a generated file against the live
> one** — build the content from live config using the cutover's own option assembly
> (`scripts/ingress-cutover.js`) and diff. Do **not** audit by grepping for
> `NOTE (manual, …)` markers: that method only finds edits whose author remembered to
> annotate them, and it is what caused #845 to report "the drift is one setting" when
> it was two.

If terminals start dying at 1006 after an ingress change, check this block first.

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
