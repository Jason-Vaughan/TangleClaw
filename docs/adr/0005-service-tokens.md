# ADR 0005: M2M Service Token — Gating the Localhost PortHub & Shared-Docs APIs

**Status:** Accepted (2026-06-29, AUTH-4 / #1). Ships behind the `serviceTokenEnabled` config flag (default `false`) — inert on existing installs; enabling it is a reversible opt-in.
**Source issue:** #1 — Add user authentication (AUTH track). **Chunks:** #410 (slice 4a — gate mechanism), #412 (slice 4b — management + fleet reach), this ADR (slice 4c — docs/governance).
**Builds on:** ADR 0004 (AUTH-2 Caddy `basic_auth`). AUTH-2 gates *remote* callers at the ingress; this ADR gates the *local* machine-to-machine callers `basic_auth` structurally cannot reach. **Closes** the AUTH track.

---

## Context

ADR 0004's `basic_auth` gate sits in Caddy and fronts every surface for **remote** callers. But
TangleClaw is also a **fleet coordinator**: every project's session, on the same box, calls back
into TC's HTTP API to register ports (PortHub — `/api/ports*`) and read/sync shared documents
(`/api/shared-docs*`, `/api/groups/:id/sync`). Those callers hit the **direct localhost listener**
(`localhost:3102`), which is not proxied by Caddy — so the `basic_auth` gate never sees them. That
path has always been unauthenticated.

Two facts make the human gate the wrong tool here:

- **Machine callers can't do an interactive Basic Auth login.** There is no human to type a
  password; the caller is a session's config-driven `curl`.
- **The localhost path bypasses the proxy by design.** Co-located callers reach `:3102` directly
  for latency and because they don't traverse the public ingress. Routing them through Caddy just to
  authenticate would be architectural contortion.

So the otherwise-open PortHub and shared-docs surfaces need their own, M2M-appropriate gate: a
**bearer token** TC can mint, store, hand to every project, and check on each request — exactly the
part of the API `basic_auth` can't protect.

## Decision

Add a **single fleet bearer token** that, when enabled, gates exactly the PortHub and shared-docs
surfaces on the direct listener. Six properties define it:

1. **Single fleet token, not per-project.** One `tcsk_`-prefixed token authorizes both surfaces for
   every project. The callers are co-located on a single-tenant box; per-project isolation buys
   little — a compromised session already has filesystem read on `~/.tangleclaw`. Per-session
   *attribution* is already handled by AUTH-3's `sessions.owner`. Per-surface / per-project scopes
   are deferred (AUTH-5+).

2. **Default-off, reversible opt-in.** `serviceTokenEnabled` defaults `false`. When off, the gate is
   a no-op and the surfaces behave byte-for-byte as they do today — disabling restores open behavior
   exactly. Default-on would instantly `401` every existing local caller (none send a token yet) on
   the live machine; the reversibility contract is load-bearing for the whole AUTH track.

3. **Auto-generate on enable; reveal/rotate in Settings — no wizard step.** M2M means no human in
   the loop at call time, so the lifecycle is minimal: enabling auto-generates the token, the
   Settings panel reveals and rotates it. No first-run wizard step (unlike AUTH-2's admin).

4. **Raw at rest, redacted from the config API.** The token is stored raw in
   `~/.tangleclaw/config.json` (`serviceToken`), consistent with the existing `audit_secret` /
   `bridge_token` / `gateway_token` raw-at-rest secrets. It **must** be raw because TC auto-injects
   it into every project's config guide — a one-way hash would make injection impossible. It is
   redacted from `GET`/`PATCH /api/config` (a `serviceTokenConfigured` boolean is surfaced instead);
   the raw value leaves only through the dedicated, operator-authed reveal endpoint.

5. **A pathname-prefix predicate, not a per-route flag.** The gate keys on
   `requiresServiceToken(pathname)` in `lib/service-token.js`, enforced once in the central
   `handleRequest` dispatch. This is **fail-safe**: a future sub-route under `/api/ports/*` or
   `/api/shared-docs/*` is gated automatically, with nothing to remember at the registration site,
   and it avoids editing 14 fragile multi-line route registrations. The security boundary is
   declared in one auditable place.

6. **Management endpoints sit outside the gated set.** Toggle (`PATCH /api/config`), reveal
   (`GET /api/service-token`), and rotate (`POST /api/service-token/rotate`) are operator endpoints
   — gated by `basic_auth` in caddy mode / localhost in direct mode like the rest of `/api`, but
   **never** in the M2M-gated path set. A service caller holding the token must not be able to
   reveal or rotate its own gate.

The token is `tcsk_` + 32 random bytes base64url (`crypto.randomBytes(32)`), zero-dependency. The
`tcsk_` prefix makes it greppable in configs and identifiable if it ever leaks into a log it
shouldn't. Comparison is constant-time (`crypto.timingSafeEqual`, length-guarded). The gate is
**decoupled from `ingressMode`/`authEnabled`** — it protects the direct localhost path in both
direct and caddy mode.

## Consequences

- **No new runtime dependency.** Generation and comparison are node `crypto` stdlib.
- **Enable ⇒ fleet must re-acquire the token.** Injection happens at **session launch**: enabling
  (or rotating) the token only reaches a project the next time a session launches there and
  regenerates its config. Live sessions holding an old/absent token get `401` until relaunch. This
  is documented and accepted — a single operator can relaunch, and the alternative (pushing tokens
  into running sessions) is far more machinery than the threat warrants.
- **Fail-closed on misconfiguration.** Enabled-but-no-token (only reachable by hand-editing
  `config.json` — the UI auto-generates on enable) returns `500 SERVICE_TOKEN_MISCONFIGURED`, never
  a silent open gate. This is the symmetric-capability-gate discipline (ADR 0001).
- **Honest security limit.** A fully-compromised local user who can read
  `~/.tangleclaw/config.json` or any project's generated config can read the token. This gate raises
  the bar from "any process on the box" to "a process that can read TC's injected config" — it is
  attribution and lateral-movement friction on a single-tenant box, **not** a defense against a
  root-equivalent local attacker. `security-model.md` states this plainly; we do not over-claim.
- **Disable = instant rollback.** Flipping `serviceTokenEnabled` off restores open behavior with no
  config regeneration needed; the stored token is retained (inert) so re-enable is stable.

## Alternatives considered

- **Per-project or per-surface scoped tokens.** Rejected for v1: low value on a co-located,
  single-tenant box, and materially more lifecycle machinery (issue/track/revoke N tokens). AUTH-3
  already provides per-session attribution. Preserved as the AUTH-5+ upgrade if multi-tenant or
  least-privilege-per-surface ever becomes a real requirement.
- **One-way hash at rest (like `basicAuthHash`).** Rejected: TC must inject the **raw** token into
  every project's config so sessions can present it; a hash makes auto-injection impossible. The
  threat model differs from a human password — this is a bearer credential TC itself distributes,
  so raw-at-rest (matching the existing `audit_secret`/`gateway_token` precedent) is correct.
- **A per-route `requireServiceToken` flag on each registration.** Rejected: 14 fragile multi-line
  edits, and a future sub-route would be open until someone remembered to flag it. The pathname
  predicate is fail-safe and centrally auditable.
- **Reuse the AUTH-2 `basic_auth` gate for these callers.** Rejected: the callers are on the
  localhost path Caddy doesn't front, and they can't perform an interactive login. Routing M2M
  traffic through the human ingress to authenticate is the contortion this token avoids.
- **Default-on.** Rejected: it would `401` every existing local caller the instant the version
  landed on the live machine. Default-off opt-in matches the whole AUTH track's reversibility
  contract.
