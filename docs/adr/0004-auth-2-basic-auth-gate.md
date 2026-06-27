# ADR 0004: Authentication Gate — Caddy `basic_auth`, Forced Setup, Break-Glass Recovery

**Status:** Accepted (2026-06-27, AUTH-2 / #1). Ships behind the `authEnabled` config flag (default `false`) and is only live once an operator cuts over to caddy ingress — inert on existing installs.
**Source issue:** #1 — Add user authentication (AUTH track). **Chunks:** #403 (slice 1), #404 (slice 2a), #405 (slice 2b), #406 (slice 3), this ADR (slice 4).
**Research:** `.claude/plans/auth-research-2026-06-16.md` (deep-research, adversarially verified); live AUTH-1 cutover finding (`VRF-auth-1-cutover`, 2026-06-24) that the operator runs on a hand-edited Caddyfile.
**Builds on:** ADR 0003 (single Caddy ingress). AUTH-2 puts the auth gate *in* that ingress. **Consumed by:** AUTH-3 (TC reads the proxy identity → owner/#347).

---

## Context

ADR 0003 introduced Caddy as an optional single ingress so that **one** chokepoint fronts every
human surface — the HTTP API, the three WebSocket routes, ttyd, and the proxied OpenClaw gateway.
AUTH-1 deliberately added *ingress only, no authentication*. AUTH-2 is the authentication.

TangleClaw's historical posture is "trusted local network, no user auth" (`deletePassword` gates a
few destructive operations, not read access). The operator now reaches the dashboard remotely over
Tailscale, so "anyone who can reach the port has full control" is no longer acceptable: a login gate
must sit in front of every surface, at the one ingress ADR 0003 established.

Two constraints shaped the decision, both learned the hard way:

- **Zero runtime dependencies that need a toolchain.** TC ships as a clone + `install.sh`; it cannot
  assume Go, Docker, or a container runtime on the host.
- **The live ingress is load-bearing and already hand-edited.** `VRF-auth-1-cutover` revealed the
  operator runs a **hand-edited** Caddyfile (a `basic_auth` block + a Tailscale remote-access site).
  Any AUTH-2 mechanism must preserve that file, not regenerate over it, and must never be able to
  lock the operator out with no recovery path.

## Decision

The gate is **Caddy's built-in `basic_auth` directive** (HTTP Basic Auth, bcrypt-hashed password),
emitted by `lib/caddy.js` into the same Caddyfile ADR 0003's generator already owns. Four properties
define it:

1. **One site-level gate covers everything.** `basic_auth @protected` with matcher
   `not path /api/health` is attached at the *site* block, so it covers every path — HTTP API, all
   three WS routes, ttyd, and the proxied gateway — while `/api/health` stays public for liveness
   probes. `reverse_proxy` forwards the WebSocket `Upgrade` transparently, and a browser that has
   authenticated to the origin replays the `Authorization` header on same-origin WS handshakes, so no
   per-route auth config is needed. (Live confirmation of the WS replay is `VRF-auth-2-login`.)

2. **No default credentials; setup is forced.** There is no seeded admin, no default password. The
   first-run wizard gains a **blocking** Admin Login step, shown only in caddy mode, that collects a
   username + password. `/api/setup/complete` (and the wizard's Skip path) **reject** completion in
   caddy mode without an admin (`ADMIN_REQUIRED`) — there is no way to finish setup with the gate
   un-provisioned. Passwords are validated (≥12 chars, bundled weak-password denylist,
   no-username-match, no control chars), hashed via a `caddy hash-password` shell-out (no new
   dependency; plaintext passed on **stdin**, never argv), and only the **bcrypt hash** is stored —
   never the plaintext.

3. **The wizard persists the credential; the cutover flips the live gate.** `/api/setup/complete`
   writes `authEnabled=true` + the credential to config and returns a **warning** to run
   `ingress-cutover.js --to caddy`; it does **not** itself rewrite + reload the live Caddyfile.
   Activation is the existing fail-closed, `--rollback`-able cutover primitive, run at a terminal.

4. **Break-glass recovery guarantees no permanent lockout.** `scripts/reset-admin.js`, run **at a
   terminal on the host**, resolves the admin user from the live Caddyfile, validates + hashes a new
   password, and **patches the credential line in place** (never regenerates — the hand-edited file
   survives). It is fail-closed: `caddy validate` before the reload, timestamped `.bak` restored on
   failure, so a recovery run can never itself break the ingress.

`authEnabled` is a config-level flag **decoupled from `ingressMode`**: it can be set in direct mode
but is inert until a caddy cutover passes the credential through. Single admin, no MFA for v1
(multi-user/MFA are the deferred Path B story below).

## Consequences

- **No new runtime dependency.** `basic_auth` and `hash-password` are built into the Caddy binary
  AUTH-1 already requires. No Go, no xcaddy, no container.
- **The wizard-persists / cutover-activates split** means a caddy-mode-first-run install has the
  credential stored but the gate not yet live until the operator re-cuts-over. Accepted: it keeps the
  live flip inside the one tested, reversible primitive and avoids a headless-launchd reload from the
  setup endpoint (the TCC/privilege hazard class flagged in `.prawduct/learnings.md`) and the
  lockout / WS-401 window that flipping the gate *before* break-glass existed would have opened.
- **Recovery proves physical control, not a remote door.** `reset-admin.js` runs only at a terminal
  on the host (the `launchctl` reload domain is per-uid, machine-local). It never opens a network
  recovery path — the correct posture for break-glass: a lost password is recoverable iff you have
  physical/SSH access to the host, and never otherwise.
- **HTTP Basic Auth has known ergonomics limits** (no server-side logout — the browser caches the
  credential until it's closed; one shared admin identity). Accepted for a single-operator tool;
  richer session/portal/MFA semantics are the Path B upgrade.
- **The gate is one credential for all surfaces.** AUTH-3 will read the proxied identity to attribute
  ownership (#347); AUTH-4 adds M2M service tokens for PortHub / shared-docs. Basic Auth gives AUTH-3
  a `username` to consume without further work here.

## Alternatives considered

- **Authelia forward-auth (the original AUTH-2 plan).** Rejected: (1) no macOS binary — it assumes
  Docker/Linux, violating the zero-toolchain constraint; (2) it refuses to set a session cookie for
  `localhost` / `.local` / bare-IP hosts even inside Docker, which is exactly the host set TC runs on
  (`localhost:8443`, `cursatory.local`, Tailscale IPs). It cannot gate this deployment at all.
- **caddy-security (greenpau) portal — "Path B".** Deferred, not rejected: it *does* work on
  localhost (omit the cookie domain) and would give a real login portal, multi-user, and MFA. But it
  is a **compile-time** Caddy plugin: it turns the ingress binary into a custom `xcaddy build`
  requiring Go as a build prereq, replacing AUTH-1's brew/Homebrew Caddy. For a single-operator system
  that one admin + Basic Auth fully serves, the Go/xcaddy ripple and the single-maintainer bus-factor
  of the plugin aren't worth it **yet**. Preserved in the spec as the future upgrade path the moment
  multi-user, a portal, or MFA becomes a real need. (`.prawduct/artifacts/auth-2-authelia-gate.md`
  "Path B — DEFERRED".)
- **In-process Node auth (Better Auth / hand-rolled scrypt).** Rejected for the same reason as in
  ADR 0003: every surface (HTTP, WS, ttyd, gateway) is hand-wired, so it becomes roll-your-own auth
  across four transports — the footgun the single-ingress model exists to avoid.
- **Default admin credentials seeded on first boot.** Rejected: a shipped default password is the
  classic appliance vulnerability. Forced setup with no default is strictly safer and barely costs
  the operator anything (one wizard step they must complete anyway).
- **Wizard regenerates + reloads the live Caddyfile itself.** Rejected: it duplicates the cutover's
  context derivation (cert staging, ports, socket) in the headless launchd server, and would flip the
  live gate before break-glass recovery existed. Persisting the credential and letting the tested
  cutover apply it keeps a single fail-closed activation path.
- **A network-reachable password-reset endpoint.** Rejected: a remote recovery door is an
  authentication bypass by another name. Break-glass is deliberately terminal-only.
