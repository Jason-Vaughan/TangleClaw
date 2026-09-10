# ADR 0015: TangleClaw owns authentication — the gate moves out of Caddy

**Status:** Proposed (2026-09-10). Operator-approved for exploration; not built.
**Source issues:** #1149 (v6 multi-user architecture), #803 (the wizard's opt-out), #1055.
**Supersedes, conditionally:** ADR 0004 / `auth-2-authelia-gate.md`'s Path A choice — on the exact
condition that choice named for itself.
**Builds on:** ADR 0003 (ingress model), ADR 0009 (secure by default).

---

## Context

TangleClaw's login is Caddy's `basic_auth`, written into a generated Caddyfile. That was chosen
deliberately on 2026-06-24, over Authelia (rejected 2026-06-23) and caddy-security (Path B), and the
decision recorded its own expiry in its fourth rationale bullet:

> **Single-operator system.** Portal / logout / session-expiry / MFA / multi-user (Path B's upside)
> aren't pressing for one operator. Path B remains a clean **future upgrade** if that changes.

**That condition has now arrived.** #1149 puts multi-user on the roadmap with an explicit resource
model — `User → Membership → Workspace → Project → Session → Agent` — plus request identity,
authorization, resource scoping and auditability.

This ADR is not a reversal. It is the upgrade the 2026-06-24 decision reserved.

### What `basic_auth` structurally cannot do

One shared credential in a generated file. Not "does not yet" — cannot, without becoming a different
mechanism:

| Requirement (#1149) | Under `basic_auth` |
|---|---|
| Per-person accounts | One credential for everyone |
| Revoke one person | Change the password for everyone |
| Roles / authorization | No principal to attach them to |
| Logout, session expiry | Browsers cache Basic credentials per origin; there is no logout |
| Audit "who launched this shell" | Every request is the same username |

The audit row is the sharpest one. TangleClaw launches agent sessions with shell access. A multi-user
system that cannot attribute a shell to a person is not multi-user; it is a shared account.

### Two costs already being paid

1. **The credential only works in caddy mode.** `lib/store.js:133` — "The gate lives at Caddy, so
   these only take effect in caddy ingress mode." So `basicAuthUser`/`basicAuthHash` in a direct-mode
   config enforce nothing. This is what made #803's follow-up requirement ("adding a credential
   un-restricts the binding") unsafe: it would have opened a wide bind guarded by a credential no
   code path reads.
2. **TangleClaw cannot verify a password it stores.** `server.js:1725` — "What authenticates this
   request is that Caddy already did." `caddy hash-password` has no verify mode and Node has no
   bcrypt, so there can be no current-password field on a change form, and the credential route must
   refuse whenever no gate is in force.

## Decision

**TangleClaw authenticates its own requests. Caddy terminates TLS and stops being the gate.**

Sessions are established by TangleClaw against a user store TangleClaw owns, using **scrypt** from
Node's standard library.

**This adds no dependency.** TangleClaw already ships the primitives, at `lib/projects.js:59-77`,
today guarding project deletion:

```js
crypto.scryptSync(password, salt, 64)  // hash, random per-user salt
crypto.timingSafeEqual(...)            // verify, constant-time
```

ADR 0012 (enforcement adds no install step) is satisfied: no `xcaddy`, no Go toolchain, no
single-maintainer Caddy plugin on a rebuild-on-security-bump treadmill — which was Path B's real
cost and the reason it lost in June.

### Why not Path B (caddy-security) now that multi-user is real

It would deliver sessions and multi-user, but it puts **identity in the proxy** while #1149 puts
authorization in TangleClaw's data model. Memberships, workspace scoping and per-resource permissions
have to live where the resources are. A proxy that separately decides who may knock is then a second
source of truth about identity, and this project has a standing position on those. If TangleClaw must
know the principal to authorize anything, it should also be what established it.

### What Caddy keeps

TLS termination, the h1 pin, the tailnet/LAN/public site shapes, ACME. All of it stays. Caddy is a
good reverse proxy and this ADR does not dispute that — it disputes only that the gate belongs there.

## Answering ADR 0004's rejection

ADR 0004 did not merely prefer Caddy — it **rejected this mechanism by name**: "In-process Node auth
(Better Auth / hand-rolled scrypt). Rejected … every surface (HTTP, WS, ttyd, gateway) is hand-wired,
so it becomes roll-your-own auth across four transports — the footgun the single-ingress model exists
to avoid."

That objection was correct and must be answered, not stepped around.

**What changed: the four transports are no longer four doors.** TangleClaw internally proxies ttyd
and the OpenClaw gateway — `lib/caddy.js` states it plainly, which is why the generated Caddyfile
carries a single `reverse_proxy 127.0.0.1:<serverPort>` and not four. All four surfaces therefore
enter through TangleClaw's own request path, so a session check at that entry is one gate covering
four paths, not four gates. The "single-ingress model" ADR 0004 wanted to preserve is preserved; what
moves is *which process* holds it.

**What the objection still gets right**, and this ADR does not pretend otherwise:

- **The WebSocket upgrade is genuinely separate.** Three WS routes exist and an upgrade request must
  be authenticated before the socket is established, not after. This is the single most likely place
  to get it wrong, and it is open question 1 rather than a solved problem.
- **`/openclaw-direct/*` carries its own gateway token** and is deliberately exempt from the current
  gate (`AUTH_BYPASS_PATHS`). Two auth systems on adjacent paths is exactly the complexity ADR 0004
  feared. `isCaddyAuthBypassPath` already models the boundary, so the seam exists — but it must be
  moved deliberately, not inherited.
- **"Roll-your-own auth" remains the real cost.** ADR 0009's threat model is arbitrary code
  execution as the operator. Session fixation, CSRF on state-changing routes and cookie flags become
  TangleClaw's to get right. The mitigation is scope, not confidence: sessions and password
  verification only, with recovery staying a terminal tool outside the gate.

The claim here is not that ADR 0004 was wrong. It is that its rejection rested on a topology that has
since changed, and on a requirement — one operator — that #1149 retires.

## Consequences

**Enables**
- #1149's model, with a real `User` to hang membership and audit on.
- Auth in **direct mode**, removing the caddy-mode coupling above.
- A safe wide bind: once TangleClaw is the gate, ADR 0009's "something is guarding the door" is
  satisfied without a reverse proxy in front, which simplifies `lib/bind-policy.js` rather than
  weakening it.
- Password change with current-password verification, and real logout.

**Costs and risks**
- **Writing authentication is a security-critical build**, not a refactor. Session token generation,
  fixation, timing, CSRF on state-changing routes, and cookie flags are all now TangleClaw's problem
  where Caddy previously owned them. This is the honest argument against this ADR and it should be
  weighed, not waved past.
- **A migration exists**, unusually for this project: live installs carry a `basicAuthHash` (bcrypt)
  that scrypt cannot verify. Operators must set a password once under the new scheme. It cannot be
  converted silently, and per ADR 0009 it must not degrade to no gate meanwhile.
- **Recovery must stay outside the gate.** ADR 0009 rule 5 is unchanged: `scripts/reset-admin.js` on
  the machine, never a dashboard feature.
- **The bypass paths change owner.** `/api/health`, `/openclaw-direct/*` and `/manifest.json` are
  currently exempted in the generated Caddyfile (`AUTH_BYPASS_PATHS`). They become TangleClaw's to
  enforce, and `isCaddyAuthBypassPath` already models them — one definition, moved, not duplicated.

## Open questions for the build

1. **Cookie or bearer token?** The dashboard is same-origin; ttyd and the OpenClaw gateway are
   proxied through TangleClaw, so a cookie likely covers all three. Confirm against the WebSocket
   upgrade path before committing.
2. **Does `X-Auth-User` (AUTH-3) survive?** It is currently populated by Caddy's `basic_auth`. If
   TangleClaw establishes identity, the header becomes internal and its forgery guard changes shape.
3. **What happens to `authEnabled`?** Under ADR 0009 the unprotected state is a deliberate opt-out.
   That survives, but it stops meaning "no Caddy gate" and starts meaning "no TangleClaw session
   required" — which is a clearer thing to explain in the wizard than the current coupling.
4. **Ordering against #804.** That issue derives the "a credential is mandatory here" predicate
   from three call sites, and this ADR changes what the predicate *means*, so #804 should follow it
   rather than precede it. (Named by issue deliberately: it sits in a Train 16 chunk whose number
   moves, and `train-16-chunk-01.md` has an unrelated internal C2.)
