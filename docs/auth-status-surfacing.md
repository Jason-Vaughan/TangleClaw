# Auth status surfacing

**Status: built. Re-derived 2026-09-13 (#1420 A-02b) from TangleClaw's own gate state; the original
AUTH-2K9D design (2026-07-08, amended 2026-07-17 by AUTH-5N2J) compared config against a Caddy-set
identity header, and is kept below as history.**

Related: [ADR 0016 — Tier 1 auth build decisions](adr/0016-tier-1-auth-build-decisions.md) (OQ2,
"Recorded during #1420 A-02a" for the gate states, and "Recorded during #1420 A-02b" for this status), `lib/auth-gate.js#resolveGateState`, `lib/auth-identity.js`,
`lib/server-info.js`.

## Problem

An operator must not believe TangleClaw is access-controlled while it enforces nothing, nor be left
guessing why a login is closed. `GET /api/server-info` reports `authStatus`, and the dashboard shows a
warning chip for the states that need the operator.

## State model (current)

`authStatus` IS the request's gate state (`lib/auth-identity.js#resolveAuthStatus`), reported as-is —
the same value `/api/auth/me` reports as `gateState`. The gate state is the single owner of whether a
login is enforced; nothing here reads config or a request header, and there is no second vocabulary
mapped onto it (a rename map is where a newly added state gets labelled wrongly).

| `authStatus` (= gate state) | Meaning | Dashboard chip |
|---|---|---|
| `open` | `authEnabled` is not on — no login required (ADR 0009's opt-out) | none |
| `armed` | TangleClaw enforces its login, on any ingress mode | none |
| `account-required` | login on, no account yet — closed | ⚠ open a new tab to create the account |
| `locked` | accounts exist, none enabled — closed | ⚠ run `reset-admin.js --store` at a terminal |
| `unreadable` | the gate could not read its state — closed | ⚠ check the server log |
| `fallback` | the login is stood down behind Caddy's password (`scripts/gate-fallback.js`) | ⚠ run `gate-fallback.js --undo` once the login works |

A value that is not a gate state maps to `unreadable`, never `open`: a status that fails toward "no
login required" would tell the operator the door is open when the code cannot say so. A state added to
the gate is a valid status automatically, and `test/auth-status-warning.test.js` goes red until the
chip's rendering of it is decided.

**A browser rarely sees the three closed-state warnings.** A closed gate refuses the `/api/server-info` poll that
would carry them to a signed-out page. They reach a local tool through the fleet carve-out, and a
signed-in page left open across a change. The chip exists so that, when it does render, it names the
state honestly rather than showing nothing.

`currentUser` is the TangleClaw session's username, or null. An inbound `X-Auth-User` header is deleted
at request entry (`lib/auth-identity.js#refuseInboundIdentity`) and is never identity.

### Surface

`public/landing.js#_authStatusWarning` maps the value to text; `#renderAuthStatus` shows or clears the
chip on every poll. **State-driven, not a notification** — no dismiss control and no timer (the
no-UI-timers rule); removing the cause removes the chip on the next poll. Text carries the meaning so
the chip is not color-only (a11y).

## History — the AUTH-2K9D design this replaced

The first design derived `authStatus` from config `{authEnabled, ingressMode}` plus the Caddy-forwarded
`X-Auth-User` identity, because at the time Caddy's `basic_auth` was the only gate and direct mode had no
in-process login:

- `configured-inert` — `authEnabled` in direct mode, where nothing enforced it.
- `configured-no-identity` — caddy mode, a request that came through Caddy (`X-Forwarded-For`) with no
  identity: a Caddyfile missing `header_up X-Auth-User`.
- `configured-bypassed` (AUTH-5N2J) — caddy mode, a request that reached the loopback listener without
  Caddy, whose missing identity said nothing about gate health.

All three described a disagreement between Caddy's gate and a header. #1418 gave TangleClaw its own
login on every mode, and #1420 stopped reading the header, so none of the three can occur and all were
removed. The AUTH-5N2J observation survives in a different place: Caddy's `X-Forwarded-For` is now what
keeps forwarded traffic out of the fleet carve-out (`lib/auth-gate.js#isMachineClient`).
