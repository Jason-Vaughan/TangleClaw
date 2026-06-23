# ADR 0003: Reverse-Proxy Ingress (Caddy), Reversibly

**Status:** Accepted (2026-06-22, AUTH-1 / #395). Ships behind `ingressMode` default `direct` — inert until an operator cuts over.
**Source issue:** #1 — Add user authentication (AUTH track). **This chunk:** #395 (AUTH-1).
**Research:** `.claude/plans/auth-research-2026-06-16.md` (deep-research, adversarially verified).
**Related:** AUTH-2 (forward-auth gate) consumes this single ingress; ADR 0002 (wrap pipeline) is unrelated.

---

## Context

Through v3.26 TangleClaw terminated its own HTTPS (mkcert via `lib/https-setup.js`) and exposed
ttyd directly on TCP `:3100`. TC already hand-rolls reverse-proxying for ttyd (`/terminal`) and the
OpenClaw gateway over raw sockets, but there is no single ingress chokepoint and no path to real
public TLS (mkcert cannot issue for a public domain). Both are prerequisites for the AUTH-2
forward-auth gate, which must sit in front of **every** human surface — HTTP API, the three
WebSocket routes, ttyd, and the proxied gateway — at one point.

The operator was explicit about reversibility ("if we break something we need to roll back"), since
this touches the live ingress of a tool they depend on.

## Decision

Introduce **Caddy** as an optional single ingress, selected by a new `ingressMode` config flag:

- **`direct`** (default): unchanged. TC terminates HTTPS and binds all interfaces; ttyd on `:3100`.
- **`caddy`**: TC binds `127.0.0.1` plain-HTTP; **Caddy terminates TLS** (reusing the existing
  mkcert cert for `localhost`, ACME for a configured `publicDomain`) and is the only path; ttyd
  rebinds to a Unix domain socket so it is unreachable except via the proxy chain.

Caddy fronts **TC**, not ttyd/gateway directly — TC keeps its existing internal proxies (and, in
AUTH-2, injects ttyd's auth header from behind the gate). Caddy runs as a **no-sudo user
LaunchAgent** on non-privileged ports (`caddyHttpsPort`/`caddyHttpPort`, default `8443`/`8080`);
443/80 for a real public domain is a documented root-LaunchDaemon path (`deploy/INGRESS.md`).

The flip is a deliberate operator step — `scripts/ingress-cutover.js` (`--to caddy|direct`,
`--dry-run`) — that is **fail-closed** (`caddy validate` before any launchd reload) and reversible
(`--rollback` restores `direct` exactly). The cutover is the live-verification surface
(`VRF-auth-1-cutover`); the launchd/socket binding cannot be unit-tested, so its orchestration is
verified by the operator, while the pure logic (Caddyfile generation, the cutover plan, the
transport switch) is unit-tested.

**No authentication** is added here — AUTH-1 is ingress only.

## Consequences

- `direct` mode is byte-identical to the historical behavior, so rollback is "do nothing different."
  This is why the transport switch is mode-conditional rather than "ttyd always on a socket."
- One new external dependency (the Caddy binary), gated to caddy mode and the cutover.
- `lib/https-setup.js` stays as the direct-mode TLS path (the rollback target), now superseded by
  Caddy in caddy mode; its removal is deferred until the cutover has soaked in production.
- `lib/caddy.js` (Caddyfile gen/validate, transport target) and the `ingressMode` branch in
  `server.js` are platform-agnostic and reused for the future Linux/systemd port; only the
  process-manager glue (`scripts/ingress-cutover.js`, the plists) is macOS-specific today.
- PortHub keeps the ttyd `:3100` lease in caddy mode even though nothing binds it there. This is
  intentional: holding the port keeps it free so a rollback to `direct` rebinds cleanly instead of
  racing another project for `:3100`.

## Alternatives considered

- **In-process Node auth (Better Auth / hand-rolled scrypt).** Rejected: every surface (HTTP, WS,
  ttyd, gateway) is hand-wired; realistically becomes roll-your-own auth — the footgun being avoided.
  (Research: Lucia EOL, csurf archived, Better Auth new/under-battle-tested.)
- **Full IdP (Keycloak/Authentik/Zitadel/Ory).** Rejected: 4+ containers for a single operator.
- **ttyd always on a Unix socket (both modes).** Rejected: cleaner, but changes current behavior and
  weakens the "rollback = exactly today" guarantee the operator asked for.
- **Caddy on 443 by default (root LaunchDaemon).** Rejected as default: needs sudo and runs Caddy as
  root; the no-sudo `:8443` user-agent path is the default, with 443 documented for public domains.
