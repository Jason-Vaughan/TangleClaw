# ADR 0016: Tier 1 auth — the build decisions ADR 0015 left open

**Status:** **Accepted (2026-09-11).** Decided at the start of the Train 9 build, before any gate
code was written, because three of them bind more than one chunk and a late answer means rebuilding
an earlier one.
**Extends:** ADR 0015 (TangleClaw owns authentication). Does not amend it — 0015's reasoning stays
readable as written; this records what the build decided against its open questions.
**Source issues:** #1416 (this ADR), #1417, #1418, #1419, #1420.

> Code is cited here by file and symbol, never by line number. ADR 0015 cites `lib/store.js:133`
> for the caddy-mode coupling; that comment was already at line 150 when 0015 was written, and
> has moved again since. A citation that decays silently is worse than a vaguer one that does not.

---

## Context

ADR 0015 is Accepted and ships five open questions "for the build". Three of them are architecture
decisions rather than build steps:

- **OQ1 (cookie or bearer)** binds the HTTP gate *and* the WebSocket gate — two chunks.
- **OQ2 (`X-Auth-User`)** and **OQ3 (`authEnabled`)** bind the cutover and the wizard copy.

Plus the migration mechanism, which 0015 describes as a constraint ("cannot be converted silently",
"must not degrade to no gate meanwhile") without saying how it is met.

OQ4 (ordering #804 after the cutover) and OQ5 (tier 2's shape) are already settled by 0015 itself
and by the train plan, and are not reopened here.

---

## OQ1 — Cookie. Not a bearer token.

**Decision: an `HttpOnly` session cookie, scoped to the TangleClaw origin.**

ADR 0015 guessed this ("a cookie likely covers all three") and told the build to confirm it against
the WebSocket upgrade before committing. Confirmed, and the WebSocket path does not merely permit a
cookie — it **rules the alternative out**:

**A browser cannot set a header on a WebSocket handshake.** The `WebSocket` constructor takes a URL
and a subprotocol list; there is no header argument. So a bearer token could only reach
`server.js`'s `handleUpgrade` by one of:

- the **query string** — which puts a live credential into every access log, the referer of anything
  the page loads, and the `log.warn` calls already in `handleUpgrade` that print `path`;
- the **`Sec-WebSocket-Protocol`** header, abusing a subprotocol negotiation field as a credential
  channel. It works, and it is a known hack precisely because nothing else does.

A cookie, by contrast, is attached by the browser to a same-origin upgrade automatically, arrives
as `req.headers.cookie` on the very `req` that `server.js`'s `handleUpgrade` already inspects, and
can be `HttpOnly` so page script cannot read it. The dashboard, `/terminal/*` and the OpenClaw gateway are all reached
through TangleClaw's own origin, so one cookie covers all three — which is the claim ADR 0015 rests
its "one gate, four paths" answer to ADR 0004 on.

**Cookie attributes:** `HttpOnly` always. `Secure` whenever the request scheme is https — not
unconditionally, because a direct-mode install on plain http over the tailnet is a supported shape
(ADR 0003) and a `Secure` cookie would silently never be stored there, producing a login that
appears to succeed and then does nothing. `SameSite=Lax`, so top-level navigation to the dashboard
carries the session while cross-site form posts do not; `Lax` is not itself CSRF protection and the
token in #1418 is (see below).

**The consequence this decision creates, and where it is handled.** Both WebSocket proxies forward
request headers to their upstream, so the session cookie would reach ttyd and the OpenClaw gateway:

- `server.js`'s `/terminal` branch of `handleUpgrade` copies **every** header except `Host`
  verbatim into the upgrade request it writes to ttyd.
- `_openclawWsRequestLines` strips `authorization` — deliberately, per #470 — and forwards
  everything else, `cookie` included.

Neither upstream has any use for TangleClaw's session cookie, and a credential that travels further
than it is needed is how the #470 class of bug happens. **The gate strips its own session cookie
before proxying**, on both paths, and #1419 owns that.

**Rejected: bearer token in `localStorage`.** Beyond the handshake problem, it is readable by any
script on the origin, which trades an `HttpOnly` guarantee for nothing. ADR 0009's threat model is
arbitrary code execution as the operator; the dashboard renders operator-authored content.

## OQ2 — `X-Auth-User` becomes internal, and its forgery guard inverts

**Decision: the header survives as an INTERNAL representation only. TangleClaw stops trusting it on
inbound requests entirely, and `lib/auth-identity.js`'s job inverts from "interpret it" to "refuse
it".**

Today `lib/caddy.js` emits `header_up X-Auth-User {http.auth.user.id}` into the generated gate,
Caddy overwrites any client-supplied value, and `lib/auth-identity.js` reads the result as the
authenticated username — with a documented state machine for "gate up but no identity arriving"
(AUTH-3).

Once TangleClaw establishes identity itself, that arrangement has no remaining job and becomes a
liability: an inbound `X-Auth-User` would be a second source of truth about who the caller is, which
this project has a standing position against (ADR 0015, "Why not Path B"). After the cutover there
is no `basic_auth` block, so nothing overwrites a forged header, and any code still reading it would
be reading the attacker's claim.

So:

- **Inbound `X-Auth-User` is deleted from `req.headers` at the request entry**, before any routing,
  and its presence is logged at warn. Not merely ignored — deleted — so a later reader cannot
  reintroduce trust in it by accident.
- **`lib/auth-identity.js` keeps its module and its tests**, retargeted: identity comes from the
  session, and the AUTH-3 "configured-no-identity" state is replaced by a "forged header refused"
  state. The module is where the forgery reasoning already lives; moving that reasoning would lose
  it.
- **Internal consumers** (the `activity_log` writer in `lib/store.js`, which records the
  proxy-authenticated user and NULLs it when there is none) read the session's username instead.
  That column becomes reliably populated for the first time, which is the audit capability ADR 0015
  says identity *enables* — it does not by itself commit to building an audit trail.

## OQ3 — `authEnabled` keeps its name and changes what it names

**Decision: `authEnabled` means "a TangleClaw session is required". It stops meaning "a Caddy
`basic_auth` gate is generated".**

ADR 0009's deliberate opt-out survives unchanged in *policy*: an operator can still run TangleClaw
with no login. What changes is that the setting finally means the same thing on every ingress mode,
which is the entire point of tier 1 — today it is honoured in caddy mode and silently inert in
direct mode (`lib/store.js`, on `basicAuthUser`/`basicAuthHash`: "The gate lives at Caddy, so these
only take effect in caddy ingress mode").

**Not renamed**, despite the meaning shift, because the name was never wrong — it was the
*implementation* that was caddy-specific, and a rename would touch every config, every test and
every live install's stored settings to express a change that is invisible at the call site. The
meaning is pinned by the wizard copy and by this ADR, not by the identifier.

**What must change with it** — the predicate that decides "a credential is mandatory here" is spelled
out at three call sites (#804), and after this ADR all three are asking a different question. ADR
0015 OQ4 orders #804 after the cutover for exactly this reason; it is chunk 05.

**The wizard finally gets an honest sentence.** Under #803's ruling the wizard may finish ungated;
what it could not previously say was what that opted out *of*, because the answer depended on ingress
mode. It now reads the same on every install: finish without a login, and anyone who can reach this
address is in.

## The migration — a forced set, never a silent conversion, never an open door

**Decision: an install carrying a bcrypt `basicAuthHash` enters a `credential-migration-required`
state. The gate stays CLOSED in that state and the only thing it serves is the set-a-password
screen.**

The constraint is that scrypt cannot verify bcrypt, so the stored credential is unusable, while ADR
0009 forbids degrading to no gate. Those two facts leave exactly one shape: refuse everything except
the one route that establishes a new credential.

- **Trigger:** `authEnabled` is true, a `basicAuthHash` exists, and no user row does.
- **Behaviour:** every route except the set-password route and the existing bypass paths answers with
  the set-password screen. Not a redirect to a normal login — there is nothing to log in *to* yet.
- **No current-password field.** TangleClaw cannot verify the bcrypt hash it holds; a field it cannot
  check would be security theatre. What authorises the set is **reach**: in caddy mode Caddy's gate
  is still in front during the upgrade, and in direct mode the listener is loopback-by-default per
  ADR 0009. The operator who can reach the screen is the operator who could already reach the
  dashboard.
- **`basicAuthHash` is retained, not deleted**, until the new credential verifies once. A migration
  that destroys the old credential before the new one works is a lockout with no way back.
- **Recovery stays `scripts/reset-admin.js` on the machine** — ADR 0009 rule 5, unchanged.

**This is not the kill-switch.** The migration handles an install whose credential is the wrong
*algorithm*. It does nothing for an install whose gate is *broken*, which is the failure this repo's
live-install status makes serious: the operator is almost never at this machine, and
`scripts/reset-admin.js` needs a shell on the box. A separate off-box kill-switch lands with the
cutover (#1420) and is a precondition of merging it, not a follow-up.

---

## Consequences

- #1418 builds against a decided cookie shape, and #1419 inherits it rather than choosing again.
- #1419 gains a requirement that did not exist when it was filed: strip the session cookie before
  proxying, on both WebSocket paths.
- #1420 gains the migration state machine above, and `lib/auth-identity.js`'s inversion.
- #804 (chunk 05) is confirmed as post-cutover work, per ADR 0015 OQ4.
- Nothing here touches tier 2. ADR 0015 OQ5 remains open and is deliberately not answered.
