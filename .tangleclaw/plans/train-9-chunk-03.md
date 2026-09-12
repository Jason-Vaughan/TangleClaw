# Train 9 — Chunk 03: the WebSocket upgrade gate, and the `/openclaw-direct/*` seam

**Issues:** #1419
**Branch:** `feat/1419-tier1-auth-ws-gate`
**Worktree:** **required and in use** — `.claude/worktrees/1419-ws-gate`. This chunk edits
`server.js`, and the primary checkout IS the live install. Primary stays on `main`.
**Critic mode:** chunk
**Size:** medium — one risk surface (the upgrade path), so one review.
**Train plan:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder/.tangleclaw/plans/train-9-tier1-auth-chunking.md`
**Governing ADRs:** `docs/adr/0015-tangleclaw-owns-authentication.md`,
`docs/adr/0016-tier-1-auth-build-decisions.md` (OQ1 — cookie, and the strip-before-proxy consequence).
**Baseline:** suite green at `e0afc69f`, exit 0.
**Operator go:** given in the Builder pane 2026-09-12 ("go, start Chunk 03").

---

## Confidence check

**Problem.** With TangleClaw's gate armed, `GET /terminal/x` is refused while a WebSocket upgrade to
the same prefix still establishes — and `/terminal/*` proxies to a `--writable` ttyd, so that socket
is a shell. Separately, TangleClaw's session cookie still travels to ttyd and the OpenClaw gateway on
the two WebSocket proxy paths, and `/openclaw-direct/*` is exempt from the gate on a rationale that
does not hold (below).

**Success.** With the gate armed (`authEnabled` + an enabled account):

1. An upgrade to `/terminal/*`, `/openclaw/*` or `/openclaw-direct/*` with no valid session, from a
   browser or from off-box, is refused **before** any upstream socket is opened — answered
   `401` and destroyed.
2. The same upgrade with a valid session cookie establishes, and the proxy is set up as today.
3. The same-origin guard and the #864 served-Host guard both still refuse what they refused, and
   still run first.
4. A loopback, non-browser, cookieless upgrade (the fleet's shape) behaves as it does on HTTP —
   allowed, by the same `isMachineClient` predicate, deliberately.
5. TangleClaw's own cookies are stripped from the handshake written to ttyd and to the gateway.
6. `/openclaw-direct/*` requires a TangleClaw session on HTTP and WS, and a test pins that.
7. With the gate dormant, every upgrade behaves exactly as it does today.
8. `POST /api/auth/login` refuses with 503 above a fixed number of in-flight verifications (carried
   from chunk 02's Critic R-6).

**Out of scope — each is somebody else's chunk, not a silent drop:**

- Removing Caddy's `basic_auth`, the migration state, `authEnabled`'s re-pointing, `X-Auth-User`'s
  inversion, the kill-switch — **chunk 04 (#1420)**.
- **Revisiting `isMachineClient`** — chunk 04's, as recorded in `lib/auth-gate.js`. This chunk
  applies the predicate to the upgrade path *unchanged*, so the WS side and the HTTP side have the
  same carve-out and chunk 04 revisits one thing, not two.
- Removing `/openclaw-direct/*` from **Caddy's** `AUTH_BYPASS_PATHS`. The #472 reason is still true
  while `basic_auth` is up (the gateway UI's own `Authorization` header displaces the cached Basic
  credential → a prompt loop). It stops being true when chunk 04 removes `basic_auth`.
- #804, #803 — chunk 05.

**Requirements confidence: HIGH** on the gate and the strip (ADR 0016 decides the shape; #1419's
test plan is explicit). **MEDIUM** on `/openclaw-direct/*` — #1419 says "decide here"; the decision
is recorded below and is reversible.

---

## [DECISION] `/openclaw-direct/*` requires a TangleClaw session once the gate is armed

**The exemption's stated reason is false for the path as built.** `lib/caddy.js` and
`security-model.md` say the gateway "enforces its own token auth, so bypassing the gate does not
leave them open" (#472). But TangleClaw **injects** the gateway token server-side on both proxy
paths — `server.js#_openclawProxyHeaders` (HTTP) and `#_openclawWsRequestLines` (WS) strip the
caller's `Authorization` and set `Bearer <gatewayToken>` from the stored connection. So the
gateway's token check is satisfied *by TangleClaw on behalf of whoever asked*. The only thing
between an unauthenticated caller and the operator's gateway is knowing the connection's id.

**The exemption was never about auth; it was about the Basic prompt loop.** #472's actual defect is
that the gateway UI's own `Authorization` header displaces the browser's cached Basic credential.
A session cookie does not ride `Authorization`, so tier 1 does not have that problem, and the
exemption has no job at TangleClaw's gate.

**Options considered:**

- *Keep the exemption with a written reason* — there is no true reason to write; it would record an
  open door as a decision.
- *Require a session* (chosen) — the dashboard, the viewer iframe (`public/openclaw-view.js`) and
  the tunnel probe (`public/openclaw-tunnel-state.js`) all reach the path same-origin, so the cookie
  rides them automatically (`SameSite=Lax` covers same-site subresources and upgrades).
- *Stop injecting the token* — changes OpenClaw integration behaviour well outside this chunk.

**Mechanism:** `lib/auth-gate.js` stops answering "is this a bypass path" with Caddy's list verbatim.
It uses Caddy's list **minus `/openclaw-direct/*`**, evaluated on the same canonical path, and says
why. Caddy's own list is untouched (see out-of-scope). The `server.js` #473 parity guard keeps
using Caddy's list, because it is about Caddy's normalisation, not TangleClaw's gate.

**Residual, recorded rather than implied — and NOT closed by this chunk.** In caddy mode today, an
off-box non-browser request to `/openclaw-direct/<connId>/…` passes Caddy (bypass) and arrives at
TangleClaw from loopback with no `Origin` — which is `isMachineClient`'s shape, so the armed gate
waves it through, and it is also how the install behaves with the gate dormant (every caddy install
today). The bound is the connection id, a `crypto.randomUUID()` handed only to the authenticated
dashboard. Closing it needs either Caddy to stop bypassing (#472's loop returns while Basic is up) or
the carve-out to stop trusting loopback — both chunk 04. Carried to #1420 explicitly.

## [DECISION] The upgrade verdict is its own function, not `evaluate` with `method: 'GET'`

`evaluate` carries the HTTP exemptions — the bypass list and the login surface — none of which is a
WebSocket route. Reusing it would mean a future addition to either list silently becomes a way onto a
shell socket. `authGate.evaluateUpgrade` answers four things in order: gate inactive → allow; machine
client → allow; live session → allow; otherwise refuse. No CSRF step: a handshake is a `GET`, and a
cross-site page is already refused by the Origin guard, which runs first.

## [DECISION] A refused upgrade is answered `401`, then destroyed

The two existing guards destroy silently. The session refusal writes
`HTTP/1.1 401 Unauthorized` first, because a client that is merely signed out (an expired cookie on
a dashboard left open) should be distinguishable from one refused for being cross-site — the log
line and the status say which. Nothing about the session is echoed.

## [DECISION] Login in-flight cap = 2, answered 503 + `Retry-After`

libuv's default threadpool is 4 slots, shared with fs and dns. Two concurrent scrypt verifications
leaves half the pool for the rest of the server. Not a lockout — no per-account or per-IP state, the
absence of which is already a recorded decision. The counter is released in `finally`, so a thrown
verification cannot leak a slot.

---

## Chunks of work

- **03a — `authGate.evaluateUpgrade` + `isGateBypassPath`** in `lib/auth-gate.js`, with unit tests.
- **03b — The gate in `server.js#handleUpgrade`**, after both existing guards and before any branch.
  Replaces the "not here yet" comment. Session lookup guarded the same way `handleRequest`'s is.
- **03c — Strip TangleClaw's cookies** on the `/terminal` WS header loop and in
  `_openclawWsRequestLines`.
- **03d — `/openclaw-direct/*` gated on HTTP** via `isGateBypassPath`; wiring test through
  `handleRequest`.
- **03e — Login in-flight cap.**
- **03f — `handleUpgrade`'s misplaced JSDoc** (sits above `_isSameOriginUpgrade`).
- **03g — Docs:** CHANGELOG, FEATURES.md, `security-model.md` (the false "gateway enforces its own
  token" line, and the two now-closed residuals), ADR 0016 consequence note.

---

## Status

- [ ] **03a — `evaluateUpgrade` + `isGateBypassPath`.**
- [ ] **03b — The gate in `handleUpgrade`.**
- [ ] **03c — Cookie strip on both WS paths.**
- [ ] **03d — `/openclaw-direct/*` gated on HTTP.**
- [ ] **03e — Login in-flight cap.**
- [ ] **03f — JSDoc placement.**
- [ ] **03g — Docs.**

---

## Critic record

*(pending)*

## Carried to #1420 (chunk 04)

- The `/openclaw-direct/*` residual above: remove it from Caddy's `AUTH_BYPASS_PATHS` in the same
  change that removes `basic_auth`, and revisit `isMachineClient` for both HTTP and WS together.
