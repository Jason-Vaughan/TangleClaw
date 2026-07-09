# Auth status surfacing (AUTH-2K9D)

**Status: built (2026-07-08). `/api/server-info.authStatus` + dashboard warning chip.**

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
| `configured-no-identity` | `authEnabled` && `ingressMode='caddy'` && `currentUser` null | AUTH-3: gate up but no identity arriving (missing `header_up`, or request didn't traverse Caddy) | ⚠ warning |

The `configured-no-identity` state is not a false positive: in `caddy` mode TC binds `127.0.0.1`, so a browser reaching `/api/server-info` should traverse Caddy and carry `x-auth-user`. A `null` there means the identity forwarding is broken — exactly the state to flag. The brief window after flipping to `caddy` mode but before the cutover regenerates the Caddyfile also lands here, which is correct ("configured but not live").

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
