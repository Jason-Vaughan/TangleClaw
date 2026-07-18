# Auth status surfacing (AUTH-2K9D)

**Status: built (2026-07-08). `/api/server-info.authStatus` + dashboard warning chip. Amended 2026-07-17 (AUTH-5N2J): direct-loopback bypass split out of `configured-no-identity`.**

Related: [ADR 0003 — Ingress model](adr/0003-ingress-model.md), [ADR 0004 — AUTH-2 basic_auth gate](adr/0004-auth-2-basic-auth-gate.md), `lib/auth-identity.js`, `lib/server-info.js`.

## Problem

An operator can persist `authEnabled=true` and believe TangleClaw is access-controlled while the runtime enforces nothing. The config claims protection the runtime does not deliver, and the mismatch is **silent** — on a Tailscale-reachable box that is a real exposure-vs-perception gap. Two distinct failure shapes, folded into one requirement:

- **AUTH-2 inert-config.** `authEnabled=true` with `ingressMode='direct'`. The flag is *settable but inert* — only the Caddy cutover reads `authEnabled` (`scripts/ingress-cutover.js`); direct mode has no in-process gate. So the config reads "auth on" with zero enforcement in front of it. (Critic NOTE on AUTH-2 slice 2b.)
- **AUTH-3 missing-identity.** `authEnabled=true` with `ingressMode='caddy'` yet `currentUser` resolves to `null`. The basic_auth gate may be live but not forwarding identity — e.g. a hand-edited live Caddyfile missing the `header_up X-Auth-User {http.auth.user.id}` line (the live-state hazard documented in auto-memory). Nothing today distinguishes "gate not configured" from "`header_up` missing." (Critic NOTE on AUTH-3, folded in 2026-06-28.)

## Constraint (why this is *surfacing*, not *enforcing*)

Direct mode deliberately has **no in-process auth gate** — the gate is Caddy's job (ADR 0003 / 0004); direct mode is the trusted-LAN posture. TangleClaw cannot and should not start enforcing auth in-process to "fix" the inert-config case. The correct remedy is to make the mismatch **visible** so the operator activates the real gate (run the cutover / repair the Caddyfile), not to invent a second enforcement path. This mirrors SR-7K2P's record-not-enforce shape.

## Design (decided)

### State model

Derived from config `{authEnabled, ingressMode}` and the request-resolved `currentUser` (`authIdentity.resolveRequestUser`, the existing spoof-defense trust gate — unchanged here):

| `authStatus` | Condition | Meaning | Surface |
|---|---|---|---|
| `off` | `authEnabled` falsy | Auth not configured (expected) | none |
| `live` | `authEnabled` && `ingressMode='caddy'` && `currentUser` present | Gate enforcing, identity flowing | existing 👤 chip |
| `configured-inert` | `authEnabled` && `ingressMode !== 'caddy'` (i.e. direct or any non-caddy mode) | AUTH-2: config claims auth, no gate enforces it | ⚠ warning |
| `configured-no-identity` | `authEnabled` && `ingressMode='caddy'` && `currentUser` null && `x-forwarded-for` present | AUTH-3: request traversed Caddy but no identity arrived (missing `header_up`) | ⚠ warning |
| `configured-bypassed` | `authEnabled` && `ingressMode='caddy'` && `currentUser` null && no `x-forwarded-for` | AUTH-5N2J: request hit TC's loopback bind directly without traversing Caddy — gate health unknowable from this request | none |

### The loopback-bypass split (AUTH-5N2J, 2026-07-17)

The original design claimed `configured-no-identity` could not false-positive because "a browser reaching `/api/server-info` should traverse Caddy." That held for the intended remote access path but not for local access: TC's `127.0.0.1` bind in caddy mode still accepts direct connections from the machine itself (`localhost:3102` in a local browser, AI-session `curl` checks), and those legitimately carry no identity — the chip went amber against a perfectly healthy gate on every such load (surfaced during the AUTH-2K9D VRF, 2026-07-09).

**Discriminator: proxy evidence, not remote address.** Caddy connects to TC from loopback exactly like a direct local client, so `req.socket.remoteAddress` cannot tell the two apart. What does distinguish them: Caddy's `reverse_proxy` sets `X-Forwarded-For` on every upstream request (Caddy 2.x default, all blocks in the live Caddyfile included), while a direct client sends none. So with no trusted identity:

- `x-forwarded-for` present → the request traversed a proxy that failed to forward identity → **`configured-no-identity`** (the real AUTH-3 warning, preserved).
- `x-forwarded-for` absent → the request never passed the gate → **`configured-bypassed`**, and the chip deliberately renders nothing: this request proves nothing about gate health, and the operator's actual access path (through Caddy) still reports truthfully.

**Spoof direction is safe.** `X-Forwarded-For` is consulted only to *classify the diagnostic*, never for identity trust — `resolveRequestUser`'s config-gated spoof defense is unchanged. A direct client spoofing `X-Forwarded-For` can at most show *itself* a false amber chip; it gains no identity and no access. The residual fail-silent case — a proxied request arriving with `X-Forwarded-For` stripped — would suppress a real warning, but Caddy sets the header unconditionally, so that requires a deliberately misconfigured non-Caddy proxy, outside this design's ingress model (ADR 0003).

### Signal — `/api/server-info`

Add an `authStatus` field (enum above) to the `GET /api/server-info` response, computed server-side from the loaded config + the same `resolveRequestUser(req.headers, config)` call the route already makes for `currentUser`. Pure derivation, single source of truth, unit-testable. Backward-compatible additive field; older clients ignore it.

Derivation lives in a small pure helper (e.g. `authIdentity.resolveAuthStatus(headers, config)` or a `server-info` helper) so the four-state logic is tested independently of the route.

**Exposure note:** in direct mode `/api/server-info` is already reachable unauthenticated, and every endpoint already responds — so revealing `configured-inert` leaks nothing an attacker couldn't determine by probing. In caddy mode the endpoint is behind the gate. No new exposure.

### Surface — dashboard indicator (operator's chosen placement)

`public/landing.js` `loadServerInfo` already polls `/api/server-info` and calls `renderAuthUser(data.currentUser)`. Extend that path to also render a **warning chip** next to the existing login chip when `authStatus` is `configured-inert` or `configured-no-identity`:

- `configured-inert` → `⚠ Auth enabled but direct mode isn't enforcing it — run the Caddy cutover to activate the gate.`
- `configured-no-identity` → `⚠ Auth gate is up but no identity is arriving — the live Caddyfile may be missing 'header_up X-Auth-User'.`

**State-driven, not a notification** — the chip reflects the latest poll and self-clears when the state resolves (cutover runs / header fixed). **No dismiss control and no timer** (per the no-UI-timers rule): there is nothing to auto-dismiss and nothing to hide — the indicator is a live mirror of server state, so removing the cause removes the chip on the next poll.

Text + an amber/warning color (reuse the existing `.badge-drift`/`.badge-secret` amber palette for one visual language); text carries the meaning so it is not color-only (a11y).

## Out of scope

- Enforcing auth in direct mode (deliberately Caddy's job — ADR 0003/0004).
- Running the cutover, or probing/parsing the live Caddyfile contents (the signal is derived from config + request identity, not from reading Caddy's on-disk file).
- Any change to `resolveRequestUser`'s spoof-defense (the header is still trusted only when the gate is live).
- A Settings-modal surface (operator chose the dashboard indicator only; a Settings line was the runner-up and can be added later if wanted).
- Version-history / audit of auth-status transitions.
