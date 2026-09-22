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

OQ4 (ordering #804 after the cutover) is settled by 0015 itself and by the train plan. **OQ5 (tier
2's shape) stays open** — it is not this ADR's to answer, and 0015 says to decide it before building
tier 2, defaulting to the simpler shape.

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

## Two things the store layer deliberately does not decide, and chunk 02 must

Recorded here rather than left to be noticed, because both are the kind of gap that ships as a
silent weakening at the cutover.

**Password policy has an owner: `caddy.validateAdminPassword`.** It enforces a 12-character
minimum, a weak-password denylist, no username match and no control characters, and it is live at
three call sites today for the bcrypt credential this train replaces. `store.users.create` and
`setPassword` require only a non-empty string — a defensible store-layer choice, since the store is
not where policy belongs. **So the set-password screen and any password-change surface apply
`caddy.validateAdminPassword`.** Without that line written down, the tier-1 door ships accepting a
one-character password where the Caddy door demanded twelve, and nobody would have decided that.

**`crypto.scryptSync` blocks the event loop, and a login route is not a project-delete prompt.**
At Node's defaults each call costs tens of milliseconds on a single-threaded server. That was
irrelevant guarding a rare deletion; on `POST /api/auth/login` a burst of attempts stalls every
other request, including the dashboard the operator is trying to reach. The store keeps the
synchronous call because its callers are rare and its tests are simpler for it; **the login route
uses the async `crypto.scrypt`**, or states why it does not. Note this interacts with the timing
equalisation in `store.users.verify`, which deliberately spends the same scrypt cost on a missing
account as on a wrong password — the cost is the feature, so the fix is to stop blocking, never to
stop paying.

---

## Consequences

- #1418 builds against a decided cookie shape, and #1419 inherits it rather than choosing again.
- #1419 gains a requirement that did not exist when it was filed: strip the session cookie before
  proxying, on both WebSocket paths.
- #1420 gains the migration state machine above, and `lib/auth-identity.js`'s inversion.
- #804 (chunk 05) is confirmed as post-cutover work, per ADR 0015 OQ4.

**Three more things the store hands chunk 02, recorded so they are decisions and not surprises:**

- **The stored format `salt:hash` carries no algorithm or cost tag.** Raising the KDF cost later
  therefore invalidates every existing hash, and the failure surfaces as `reason: 'bad password'` —
  indistinguishable from a real one. Kept as-is because it is already persisted for
  `config.deletePassword` and changing it now would be a migration for no present benefit. The exit
  is a prefixed format (`scrypt$N$r$p$salt$hash`) introduced the first time a parameter changes,
  with the unprefixed form read as today's defaults.
- **`store.users.getByName` returns the hash.** `list()` was deliberately made hash-free and the
  reason written down; that reasoning stops one verb short. `getByName` exists for the caller about
  to verify a password, so `GET /api/auth/me` — already on chunk 02's list — must build its response
  from the session, never from this row.
- **`verify` is synchronous and this ADR sends the login route to async scrypt.** Those cannot both
  be true at the route. Chunk 02 either gives `store.users` an async sibling that keeps the
  `_absentUserHashValue()` equalisation in its one owner, or accepts the block and says why. It must
  NOT re-implement the equalisation at the route: the equal cost is the anti-timing-oracle fix, so
  the answer to blocking is to stop blocking, never to stop paying.

- #1418 (chunk 02) gains three things that were not in it when it was filed: the password-policy
  owner above, the async-scrypt decision above, and `scripts/reset-admin.js`'s store-backed mode,
  which moved out of chunk 01 because a recovery path for a door that is not installed yet cannot
  be verified end to end.
- Nothing here touches tier 2. ADR 0015 OQ5 remains open and is deliberately not answered.

## Recorded during #1419 — the `/openclaw-direct/*` seam

ADR 0015 said this seam "must be moved deliberately, not inherited", and #1419 was the place to
decide it. **Decision: TangleClaw's session gate does not honour Caddy's `/openclaw-direct/*`
exemption; the path needs a session once the gate is armed, on HTTP and on the WebSocket upgrade.**

The exemption's recorded reason — the gateway enforces its own token — does not hold for the path
as built: `server.js#_openclawProxyHeaders` and `#_openclawWsRequestLines` drop the caller's
`Authorization` and inject the stored gateway token, so the gateway's check is satisfied by
TangleClaw on the caller's behalf. What the exemption really fixed was a `basic_auth` prompt loop
(#472), and a session cookie does not ride `Authorization`, so tier 1 does not have that loop.
Caddy keeps the exemption while `basic_auth` exists; #1420 removes both together.

Mechanism: `lib/auth-gate.js#isGateBypassPath` — Caddy's list minus that prefix, on the same
canonical path, so it can never exempt anything Caddy's list does not. The WebSocket verdict,
`#evaluateUpgrade`, takes no path at all, so no HTTP exemption reaches an upgrade.

**Recorded during #1532 — client attribution stops at the proxy.** Both builders also drop
`X-Forwarded-*`, `Forwarded` and `X-Real-IP`, so every proxied request reaches the gateway as a client
on the tunnel's loopback end. Two cases, and they differ:

- **A connection with a gateway token** (the normal setup) gains nothing new. The injected token already
  authenticates every request as the operator, so whatever OpenClaw extends to a local client, the caller
  already had through that token, and the session gate above (when armed) decides who gets it.
- **A connection with no gateway token** (`gatewayToken` may be null) reaches the gateway as an
  unauthenticated loopback client with nothing naming the real caller. The tunnel always ended on the
  gateway host's loopback, so the peer address is unchanged. What changed is that the forwarded headers
  that used to accompany it are gone, and OpenClaw 2026.9+ refuses those headers anyway. What OpenClaw
  grants an unauthenticated loopback client has **not** been verified from this repo, so for such a
  connection the session gate is the only control in front of the gateway. Configure a gateway token, and
  keep the login armed, wherever a gateway is reachable this way.

In both cases the trade-off is the same: the gateway's own records (`remoteIp`, #254 part B) now show the tunnel address instead of the operator's
machine. Rebuilding attribution was rejected, because it would still come from a hop the gateway has no
configured reason to trust, and OpenClaw 2026.9 refuses exactly that (`proxy_attribution_required`).

---

## Addendum (2026-09-13, Checkpoint 1): the cutover's kill-switch, migration state, and the machine carve-out

**Status: ACCEPTED 2026-09-13 — the operator ruled "1 + 2" at Checkpoint 1, directly in the Builder
session.** See "The ruling" at the end of this addendum; where it differs from the option table, the
ruling governs. Recorded during A-01 (#1420 discovery). Everything under "Builder decisions" is the
Builder's call and vetoable; only the recovery reach was put to the operator, because any off-box
recovery path is itself a way past the gate.

### What discovery found that changes the cutover's shape

1. **The requirement conflicts with ADR 0009 rule 5.** The train plan asks for a kill-switch
   "reachable from the tailnet" that needs no shell on this machine. ADR 0009 rule 5 says recovery
   "proves physical control", is "a terminal tool on the machine", and "deliberately opens no second
   remote door" — and ADR 0015 re-affirms it unchanged. Both cannot hold. The ruling below decides
   which yields.
2. **"Needs a shell" is not "needs physical access."** macOS Remote Login is on for this machine
   (verified listening on :22, 2026-09-13), reachable over the tailnet from elkaholic or a phone SSH
   client. And `~/.tangleclaw/EMERGENCY-RECOVERY.md` already addresses "a cold/remote Claude session"
   — a Claude Code session on this machine reached through claude.ai, which rule 5 already permits
   ("An AI assistant running locally may perform it"). Two off-box shells exist today without
   TangleClaw's dashboard in the path.
3. **Merging #1420 does not remove `basic_auth` from the live install.** The live `~/.tangleclaw/Caddyfile`
   is hand-edited (`caddy.isGeneratedCaddyfile()` is false for it, 2026-09-13) and nothing
   regenerates it on boot; the generator only writes on `ingress-cutover` and `reset-admin`. Field
   installs with a *generated* file likewise keep their `basic_auth` until something regenerates it.
   So "the generator stops emitting `basic_auth`" is not the cutover — removing the Caddy gate is a
   separate, later, state-driven step. That is good news: it gives the migration a natural
   double-gated window and gives the kill-switch a concrete "previous door" to return to.

### The question for the operator — how does the operator re-open a broken gate from off-box?

Whatever the reach, **the switch restores the previous door; it never opens one** (see "What the
switch does" below). The options differ only in how the operator triggers it.

| | Option | ADR 0009 rule 5 | New attack surface | Fails when |
|---|---|---|---|---|
| **1** | **No new door.** A terminal command, reached off-box through the shells that already exist: SSH over the tailnet (elkaholic, or a phone SSH client), or a remote Claude session on this machine. The drill proves it from the phone. | Unchanged | None | sshd is off AND no Claude session is reachable; the phone has no SSH key set up |
| 2 | **Recovery code.** A 256-bit one-time code shown once at cutover, kept offline by the operator (password manager). A route handled *before* the gate accepts it and triggers the same switch; single use, rate-limited, logged, re-issued by terminal command. | **Amended** — a second remote door, bounded to "fall back to the old gate" | Anyone holding the code can downgrade the install to its previous `basic_auth` gate (never to open) | TangleClaw's own request path is what broke — the code rides the process it is recovering |
| 3 | **Dead-man auto-revert.** For a probation window after the gate first arms, if no remote login succeeds while challenges are being served, TangleClaw falls back on its own. | Unchanged | None (silence can only cause a revert to the older gate) | Breakage after the window; a quiet week reverts a working cutover |

Rejected without a row: a GitHub-signalled switch (TangleClaw polls a repo or issue) — it makes the
operator's GitHub account a TangleClaw credential and adds an outbound dependency to the recovery path.

**Builder's recommendation: Option 1.** It keeps ADR 0009 rule 5 exactly as ratified and adds no
surface to an install whose threat model is arbitrary code execution. Its real weakness is that it
needs a working shell route, so the Checkpoint 2 drill must be run **from the phone**, not from this
box or elkaholic — if the operator cannot reach a shell from the phone on drill day, that is the
finding, and Option 2 is the fallback design. Option 2 is the strongest answer to "no shell at all",
but it shares a process with the failure it recovers and it is a standing bypass of the gate. Option 3
covers only the deploy window, which is when the risk is highest but not the only time.

### What the switch does (Builder decision, applies to every option)

**One command, fail-closed ordering: restore Caddy's gate, verify it, and only then stand
TangleClaw's gate down.**

1. Regenerate or restore the Caddyfile with `basic_auth` from the **retained** bcrypt credential,
   `caddy validate`, reload, and probe the front door for a 401.
2. Only if step 1 verified: persist a `gate-fallback` marker that TangleClaw's gate reads per request.
3. `--undo` reverses both, in the opposite order (re-arm TangleClaw first, then drop `basic_auth`).

TangleClaw honours the marker **only while the gate it falls back to is observably present** — in caddy
mode the Caddyfile on disk carries `basic_auth` (mtime-cached read); in direct mode the listener is
loopback. If the marker is set but the fallback door is absent, the gate stays armed and logs an
error. A marker can therefore never become an open door, even if the Caddyfile is later edited out
from under it.

**This changes one earlier decision.** "`basicAuthHash` is retained … until the new credential
verifies once" becomes: **retained as the fallback credential** until the operator deliberately
retires it after the VRF (chunk 05 or later). Cost: a second, older password stays live as the
fallback, and the operator has to still know it.

Direct mode has no Caddy, so its fallback is `authEnabled: false` with the listener forced to
loopback — reachable only from the box, which is ADR 0009's floor. No live install runs direct mode
remotely today.

### Builder decisions (vetoable, not part of the checkpoint)

**The migration state machine** replaces `isGateActive`'s dormancy predicate (per `lib/auth-gate.js`'s
CHUNK 04 note). One classifier, like `bind-policy#describeBindState`, read by the HTTP gate, the
upgrade gate, the generator and the dashboard:

| State | Condition | Gate |
|---|---|---|
| `open` | `authEnabled` false | allow (ADR 0009 opt-out) |
| `migration-required` | `authEnabled` + `basicAuthHash` + no loginable user | CLOSED; serves only the set-password screen, which applies `caddy.validateAdminPassword` |
| `armed` | `authEnabled` + a loginable user | session required |
| `fallback` | marker set AND the fallback door observably present | stand down behind the previous door |

`authEnabled` + no hash + no user (a wizard not finished) keeps today's behaviour and belongs to
#803/#804 (chunk 05). A read failure fails closed in every state except a successfully read `open`.

**Caddy's `basic_auth` is dropped by state, not by release.** The generator emits `basic_auth` while
the state is `migration-required` or `fallback`, and omits it only once the state is `armed`. Its two
"requires `basic_auth`" guards (`tailnetHost`, `remoteHttpCatchAll`) become "requires a gate": `basic_auth`
or an armed TangleClaw gate. On the live hand-edited file the drop is an operator-run step inside
Checkpoint 2, never an automatic rewrite.

**The machine carve-out keys on the proxy's fingerprint.** `isMachineClient` gains a fourth
condition: no `X-Forwarded-For`. Caddy's `reverse_proxy` sets it on every proxied request and replaces
a client-supplied value from an untrusted peer, so a remote caller cannot arrive without it; the `tc`
CLI, PortHub and the switchboard never send it. That also closes the `/openclaw-direct/*` residual
carried from #1419, because an off-box request to it now arrives proxied. The Caddy default is
**recalled, not yet verified** — A-02 verifies it against the installed Caddy (v2.11.4), both the
generated and the hand-edited shapes, before building on it. Residual named: a local process that
tunnels remote traffic without adding the header (an `ssh -L` forward) is treated as local, which is
correct only because holding that tunnel already means holding a shell. The rejected alternative, a
separate listener for Caddy's upstream, is structurally stronger but rewrites every live Caddyfile's
upstream line.

### The ruling (operator, 2026-09-13)

**"1 + 2: terminal recovery stays; one-time recovery codes that reset the password; ADR 0009 rule 5
amended."**

The operator has SSH from their phone, so Option 1 works for this install. They chose to add Option 2
anyway, because TangleClaw now has non-technical outside installers for whom "SSH in and run a script"
is no recovery path at all. That reason reshaped Option 2 before it was ratified:

- **A recovery code recovers the ACCOUNT, not the gate.** As first proposed, Option 2 only fell back
  to Caddy's old `basic_auth` gate. That exists only for an upgrading install: a fresh install after
  the cutover never had a bcrypt credential to fall back to. And what a non-technical user actually
  hits is a forgotten password, not a broken gate. So a code works like a 2FA backup code: a small set
  of long random codes, shown once, each single-use and stored hashed; redeeming one lets the holder
  set a new password (policy: `caddy.validateAdminPassword`) and signs them in. Every redemption is
  logged and raises a dashboard notice afterwards. The route is rate-limited, and it answers
  identically for a wrong code and an exhausted one.
- **The terminal path stays, unchanged.** `scripts/reset-admin.js` for a forgotten password, plus the
  fail-closed fallback command described in "What the switch does" for a gate that is actually broken.
  A code handled by TangleClaw cannot recover TangleClaw's own request path, and that is the failure
  #1420 was filed about.
- **ADR 0009 rule 5 is amended.** Recovery no longer requires being on the machine in every case: a
  holder of an unused recovery code may reset an account's password from off-box. Everything else in
  rule 5 stands — no recovery feature behind the gate, the terminal tool remains, and breaking a gate
  is still recovered from a shell. The cost is accepted as stated: a second way past the password,
  bounded by the code's entropy, so the real risk is theft. Since codes are typically kept beside the
  password, a compromised password manager exposes both anyway. The genuinely new risk is the pre-gate
  route's code, which gets its own tests and Critic review.
- **Scope.** Build the redemption route and page, code issuance on the `migration-required`
  set-password screen, and a "regenerate recovery codes" action (it invalidates the old set) in #1420
  (A-04). Issuing codes in the first-run wizard for a fresh install belongs with #803 (chunk 05).
- **A user who loses their codes** falls back to the terminal path, exactly as today.
- **The Checkpoint 2 drill covers both paths:** recover a password with a code from the phone, and
  recover a deliberately broken gate over SSH from the phone.


### Recorded during #1420 A-02a (2026-09-13) — the state classifier as built

Where the build departed from, or sharpened, the addendum above. Where they differ, this section
governs.

- **`credential-migration-required` is built as `account-required`, without the hash condition.**
  The trigger is `authEnabled` plus no user row, whether or not a `basicAuthHash` exists. An install
  with `authEnabled` and no hash has no key either, and leaving it dormant would be an open door once
  Caddy's gate is gone. The full set of states is `open`, `account-required`, `armed`, `locked`
  (accounts exist, none enabled: closed, with no account page, because creating an account there
  would be a way around the existing ones) and `unreadable` (a store or config read failed:
  enforces). `lib/auth-gate.js#resolveGateState` is the single owner. **This overrides the
  addendum's "`authEnabled` + no hash + no user … belongs to #803/#804"** — that install is closed
  now, not left to chunk 05.
- **The first-run wizard creates the TangleClaw account itself.** Otherwise `POST /api/setup/complete`
  sets `authEnabled` with no account, and the wizard's own follow-up requests meet the closed gate
  before its response is read. It has the plaintext at that one moment, so it creates the first
  account from the same username and password and signs the wizard's browser in. Setup that still
  ends with no account (an adopted Caddy credential has no plaintext; Skip creates nothing) says
  `account.required`, and the wizard sends the operator to the account page. What #803/#804 still own
  is the wizard's COPY and the "credential mandatory" predicate, not keeping the wizard working.
- **The first-account route hashes asynchronously**, inside the login route's concurrency cap
  (`store.users#createFirstAsync`), because it is reachable signed-out.
- **Reach authorises the first account, with no extra condition** — the addendum's argument, and it
  holds structurally: no code path deletes a user row, so `account-required` exists only before an
  install's first account. Anyone who can reach the page then could already reach the install
  ungated, or had already passed Caddy's gate. That includes a direct-mode install with a wide bind,
  so restricting the route by socket or proxy would have bought nothing and locked that install out
  remotely. **A delete verb added to the store re-opens `account-required` on an armed install**, and
  must settle this first. The first account is written by `store.users#createFirst`, which checks and
  inserts under one `BEGIN IMMEDIATE`, so a racing submission or `scripts/reset-admin.js` cannot
  produce two.
- **Read failures now fail closed in every state.** The dormant predicate failed open until the gate
  had been armed in the process (`_everArmed`). That was safe only while Caddy's gate stood in front,
  so it is gone: an unreadable store or config answers `unreadable`, which enforces. The fleet
  carve-out still applies there, so `bin/tc` survives a store fault.
- **The machine carve-out's `X-Forwarded-For` condition is verified, not recalled.** Caddy v2.11.4
  set the header on every forwarded request and replaced a client-forged value, on a plain
  `reverse_proxy` and on one carrying `header_up`. `isMachineClient` requires `proxied` to be exactly
  `false`, so a caller that omits the fact is not read as local. **Re-verify it when Caddy's version
  changes, when any Caddyfile gains `trusted_proxies` or a `header_up` touching `X-Forwarded-For`, or
  when a different local forwarder (Tailscale Serve, nginx, cloudflared) is pointed at TangleClaw.**
  The generator is pinned against the first two by `test/auth-gate.test.js`; a hand-edited live file
  is the drift check's to read (A-03).

### Recorded during #1420 A-02b (2026-09-13) — OQ2 as built

- **An inbound `X-Auth-User` is deleted at request entry on both transports**
  (`lib/auth-identity.js#refuseInboundIdentity`, called first in `server.js#handleRequest` and
  `#handleUpgrade`), as OQ2 decided. **Departure on logging:** OQ2 said its presence is "logged at
  warn". A hand-edited Caddyfile that still carries `basic_auth` sends Caddy's own `header_up` value on
  every forwarded request until the operator drops it at Checkpoint 2, so a warn on each would bury the
  log for the whole cutover window. A header that came through a proxy is therefore logged at debug; one
  that did NOT come through a proxy cannot be Caddy's, and is logged at warn. Both are deleted.
- **Identity reads the session only.** `/api/server-info` `currentUser` and a launched session's
  `owner` read `req.tcSession`. "The `activity_log` writer" in OQ2 is, in the code, the `sessions.owner`
  column stamped at launch; `activity_log` itself carries no user field.
- **`authStatus` is the gate state, reported as-is** (`open`, `armed`, `account-required`, `locked`,
  `unreadable`) — one vocabulary shared with `/api/auth/me`'s `gateState`, never a rename map, so a
  state added later (A-04's `fallback`) cannot be mislabelled. OQ2 said AUTH-3's
  `configured-no-identity` would be replaced by a "forged header refused" state. It is not a status
  value: a refused header is a log line and a deletion, and the status reports only what the gate
  enforces. `docs/auth-status-surfacing.md` records the old model as history.
- **`lib/auth-identity.js#isProxyHeaderTrusted` stays**, for the forwarded HOST
  `lib/session-ownership.js#resolveOperatorHost` reads — an address, not an identity.

### Recorded during #1420 A-03 (2026-09-13) — Caddy's side

- **`basic_auth` is dropped in `armed` and `locked` only** — one predicate,
  `lib/auth-gate.js#guardsTheDoor`, read by the generator, the drift check, the cutover and the bind
  policy. The addendum named `migration-required` and `fallback` as the states that keep it; with the
  five states A-02a built, `account-required` keeps it (whoever reaches the first-account screen
  claims the install, so a remote site in front of it still needs Caddy's gate) and so does
  `unreadable` (a failed read never removes a gate). `fallback` is A-04's.
- **The generator takes `gateState` as an option, and omitting it keeps `basic_auth`.** The cutover
  and the drift baseline pass it. `lib/admin-credential.js` (reset-admin's gate creation and
  rotation) does not yet, and behaves as before.
- **"Requires `basic_auth`" became "requires a gate"** for the tailnet site, the plain-HTTP
  catch-all and the LAN name: `basic_auth`, or a state that guards the door. The cutover's
  refuse-to-ungate guard reads the same condition.
- **The bypass list moved to TangleClaw** (`GATE_BYPASS_PATHS`: `/api/health`, `/manifest.json`),
  and Caddy's matcher is generated from it. `/openclaw-direct/*` left both lists together, as
  "Recorded during #1419" required. No `header_up X-Auth-User` is emitted.
- **An exemption is honoured only when the router serves the path it matched.** Found while moving
  the list: the canonicaliser reads `//login` and `//manifest.json` as exempt, but `new URL` routes
  both to `/`, so a request with no session was served the dashboard shell through the exemption.
  `evaluate` now requires the parsed `pathname` to equal the canonical path for the bypass list, the
  login surface and the first-account route; a disagreeing spelling is challenged.
- **Drift:** P1 holds whenever the state guards the door, and a new P5 reports `trusted_proxies` (on
  a server or a `reverse_proxy`) or a `header_up` touching `X-Forwarded-For` in the live file — the
  carve-out's premise, read by Caddy's own adapter.
- **Bind policy: caddy mode still pins loopback.** ADR 0015's "a wide bind is guarded without a
  reverse proxy" lands in direct mode: a direct-mode wide bind whose login guards the door is no
  longer reported as reachable with no password. Honouring a stored opt-in in caddy mode was
  rejected: every install that opted in before moving to caddy mode would open a plain-HTTP listener
  at its next restart after arming, from a value the UI does not show (#1055), and Caddy already
  listens on every interface. #1055 is closed by naming the stored value (option b) in the locked
  settings hint and in `ingress-cutover --to direct`'s plan.
- **`authEnabled: false` does not open a caddy-mode install whose Caddyfile is an ungated remote
  door.** The Caddyfile is written for the state at cutover time; the gate is read on every request.
  An armed cutover writes remote sites with no `basic_auth`, so flipping `authEnabled` off afterwards
  would open them. The opt-out is therefore honoured in caddy mode only while the file on disk
  carries `basic_auth`, serves nothing beyond `localhost`, or is absent
  (`lib/caddy.js#describeIngressDoor`, read per request through `server.js#_gateIngress`, cached on
  the file's mtime and size); otherwise the accounts decide as if `authEnabled` were on, and an
  unreadable file enforces. This is the addendum's fallback-marker rule — honoured only while the
  previous door is observably present — applied to the other way the gate stands down. Recovery for
  that install is `reset-admin.js --store`, or a cutover to a `localhost`-only site first.
- **The forwarded host keeps its condition (caddy ingress with `authEnabled`), with a new reason.**
  Verified against Caddy v2.11.4: `reverse_proxy` replaces a client-supplied `X-Forwarded-Host` with
  the `Host` the client sent, and in caddy mode every remote request comes through Caddy.
  `authEnabled` stays because only then has the launching request passed a login.

### Recorded during #1420 A-04a (2026-09-13) — recovery codes as built

Where the build sharpened "The ruling" above. Where they differ, this section governs.

- **A code belongs to one account.** Eight per set, 25 Crockford base32 characters (125 bits),
  normalised on input for case, spaces, hyphens and `O`/`I`/`L` so a code retyped from paper works.
- **Stored as unsalted SHA-256, not scrypt** — CSPRNG output has no dictionary to stretch against, and
  an indexed lookup by digest is what makes a wrong code, a used code and a disabled account's code
  ONE query with one answer.
- **A code never re-enables a disabled account.** `disable` is "revoke one person", and a revoked
  person's own codes must not undo it. `locked` therefore stays terminal-only, and the redemption
  route is exempt from the gate only in `armed`, the one state a code can succeed in.
- **Redemption is atomic and ends every session** the account holds; the new password is hashed
  before the write lock is taken and the code re-checked under it, so a concurrent redemption of the
  same code gets the wrong-code answer. The redeemer is signed in through the one session-issuing
  helper.
- **The password policy runs only after the code is known valid**, because it needs the account's
  username. A weak password is thus told apart from a wrong code only to someone already holding a
  valid code, and the code is not consumed.
- **"Rate-limited" is per client, failures only**: the socket address, or Caddy's `X-Forwarded-For`
  when the request came through the proxy on loopback (Caddy replaces the client's value, verified in
  A-02a); ten failures per fifteen minutes, in a bounded in-memory map. Per client rather than
  global, so one flood cannot lock the operator out of their own recovery; the entropy already makes
  guessing hopeless, so the limit bounds log and CPU churn.
- **Minting a new set needs the current password**, not only a session: a stolen cookie that could
  mint codes would leave the thief a key that survives the operator's next password change.
- **The notice is per account** and stays until the account acknowledges it or regenerates its codes.
- **Issued on the first-account screen only.** Accounts created by the first-run wizard or by
  `scripts/reset-admin.js` start with none and generate them in Settings; wizard issuance is #803.

### Recorded during #1420 (2026-09-13) — the peer guard, with TangleClaw's own login

A site name is not a boundary: Caddy listens on every interface and picks a site by the host the
client sends, so a `localhost` site with no gate serves any machine that asks for `localhost`
(GHSA-fhgg-4h57-q2f9, fixed on `main` by a peer guard on every site written without `basic_auth`).
Two #1420 decisions above rested on "`localhost` is local", and change with it:

- **The generator guards a site only when it has no gate of either kind.** A site TangleClaw's own
  login guards (`guardsTheDoor`: `armed`, `locked`) carries no `basic_auth` and no guard — it must
  answer other machines, and the login is what admits them. `account-required`, `unreadable` and
  `open` with no credential get the guard. The drift property for the guard holds outright when the
  login guards the door, like P1, and the in-place fix script refuses on such an install.
- **`authEnabled: false` in caddy mode (the A-03 rule above) now also weighs a `localhost` site with
  no `basic_auth` and no peer guard.** Ruled by the operator 2026-09-13: it counts against the
  opt-out **only when accounts exist**. With accounts, the accounts decide, as for a remote door; with
  none, the install stays open — it is ADR 0009's opt-out population, whose fix is regenerating the
  Caddyfile with the guard. `lib/caddy.js#describeIngressDoor` reports it as `unguardedLocalSite`; a
  guard counts only as both lines directly inside the site block.
- **Limit, stated:** traffic relayed in by something running on this machine (Tailscale Serve,
  `ssh -L`, a tunnel agent) arrives from loopback and passes the guard.
- **A tool that WRITES the Caddyfile resolves the gate from config and accounts, never from the file
  it replaces** (`lib/auth-gate.js#resolveIntendedGateState`, used by `ingress-cutover.js` and
  `guard-ungated-sites.js`). The request gate reads the file so `authEnabled: false` cannot open an
  install whose file has no gate; a writer asking the same question saw its own previous output's
  missing gate as the login's, wrote another ungated file, and read the same answer back — so
  `authEnabled: false` could never take effect in caddy mode through any tool. Writing for the
  configured intent breaks the loop: an `authEnabled: false` cutover writes guarded local sites (or
  refuses a remote one, which needs a gate), and the request gate reading that file agrees.

### Recorded during #1420 A-04b (2026-09-13) — the fallback as built

The addendum's "What the switch does", built. Builder decisions, vetoable.

- **`fallback` is a sixth gate state, weighed last and only over a state that enforces.** It
  overrides `account-required`, `armed`, `locked` and `unreadable` alike — `unreadable` is what a
  broken login usually looks like — and never `open`. TangleClaw asks nothing in it
  (`lib/auth-gate.js#standsDown`, used by both verdicts); `isOpen` stays exactly `open` for the
  routes whose answers must tell the two apart. `guardsTheDoor(fallback)` is false, so every writer
  and the drift check keep `basic_auth`. Writers never resolve it: the marker says the login is broken
  right now, not what the operator configured.
- **The marker** is `<TangleClaw home>/gate-fallback`, `stat`ed per request while the state would
  enforce. It is honoured only while (1) the listener TangleClaw is actually bound to — read from the
  socket's server, not config — is loopback, and (2) `caddy adapt` over the Caddyfile on disk shows
  every route reaching TangleClaw passes a gate first; or there is no Caddyfile and config says direct
  mode. Anything unreadable refuses, logged once per change of those facts.
- **The door check is stricter than the drift check's P1.** P1 merges a site's routes, so one gate
  anywhere in it satisfies the site. Here TangleClaw is about to stop asking, so routes are walked in
  evaluation order (`lib/gate-fallback.js#walkRoutes`): an `authentication` handler covers the rest of
  its list only in an unmatched route or one matched exactly as the generator's case-sensitive
  `not path_regexp` bypass gate; a matched gate covers its own route only; the peer guard covers what
  follows it; a route matching only TangleClaw's own bypass paths may proxy ungated; any handler not
  known to be inert (`invoke`, a plugin), named routes, and Caddy apps beyond `http`/`tls`/`pki` refuse.
  Error routes are checked too. A proxy counts as reaching TangleClaw unless every upstream provably
  points elsewhere (another port, or a concrete non-loopback address); the bypass-path allowance is
  void in a route that rewrites the path; and a Caddyfile that imports another file refuses, since the
  honoured verdict is cached on the Caddyfile's own mtime and size.
- **CSRF during a fallback is the Basic-auth era's posture.** TangleClaw's session CSRF step does not
  run while it stands down, and Caddy's cached Basic credential is ambient authority. The three
  request guards that were built for exactly that — `Sec-Fetch-Site: cross-site` refusal, the served-
  Host check, and the JSON-body rule on `/api/` — run before the gate in every state, so a fallback
  returns to them rather than to nothing.
- **#472 (A-03 R-1), decided: the fallback does not carry a Caddy-only `/openclaw-direct/*`
  exemption.** That path injects the stored gateway token for whoever asks, so while TangleClaw stands
  down an ungated handle for it is an open door. The door check refuses such a file, and the prompt
  loop #472 worked around returns for the gateway UI during a fallback. Accepted: a fallback is
  temporary, and the loop costs re-entering the Caddy password, not access. **Consequence for the live
  install:** its hand-maintained Caddyfile carries that handle today, so `gate-fallback.js` refuses it
  until a gated copy (the handle removed) is kept to `--restore` — a Checkpoint 2 preparation step.
- **The door check runs `caddy adapt` synchronously, once per change and only while a marker exists.**
  An asynchronous check needs a "not yet known" answer, which must enforce, so the operator recovering
  would meet the broken login until it landed. Bounded by the adapt timeout.
- **The command, `scripts/gate-fallback.js`**, in the addendum's order: a live file that already gates
  every route is left alone; otherwise `--restore <file>` or, for a generated file, a rebuild proven
  byte-identical to the file on disk from the cutover's inputs before it is rebuilt for `fallback`
  with the retained bcrypt credential — a hand-maintained file is never rewritten. Then `caddy
  validate` + restart, a probe of each site from this machine that must answer `401` with
  `WWW-Authenticate: Basic` (TangleClaw's own `401` carries no Basic challenge), and only then the
  marker, followed by asking TangleClaw for `gateState`. `--undo` removes the marker, waits for
  TangleClaw to report a state that guards the door, and only then drops `basic_auth` — from a file
  it can reproduce, or a `--restore` file; a hand-maintained file keeps it. A failed probe or marker
  write puts back any Caddyfile the run wrote. The write/validate/restart tail is
  `lib/admin-credential.js#applyCaddyfileInPlace`, shared with `guard-ungated-sites.js` and
  `pin-https-listener.js` (the third in-place tool was the recorded trigger for extracting it).
- **The drill does not break the login on purpose.** `scripts/drill-gate-fallback.js` rehearses the
  fallback, a sign-in with the Caddy password at every site, `gateState: fallback`, and the undo, on a
  working install — restoring a copy of the Caddyfile it took first, and failing unless the file ends
  byte-for-byte as it started. The state machine stands down over every enforcing state alike (unit-tested over
  each), so damaging a live store to prove it again adds risk and no coverage. This narrows the
  plan's "break the gate on purpose"; the operator may veto.

### Recorded during #1420 A-04c (2026-09-13) — the recovery tools and words, by state

- **A Caddy-credential tool asks the gate state before it describes the install.** On an install whose
  own login guards the door (`armed`, `locked`), a Caddyfile with no `basic_auth` is the intended
  shape. `lib/admin-credential.js#canChangeCredential` (the Settings surface) refuses there as
  `account-login` and names the account's recovery routes; it reads the request's gate state and only
  chooses between refusals, so it cannot allow anything it would otherwise refuse. While Caddy's
  password still stands in front of an armed login, it stays changeable.
- **`canCreateGate` requires the gate state, as it requires config** — a writer's
  (`resolveIntendedGateState`). It refuses `armed`/`locked` (a second password in front of the
  account), refuses `unreadable` (a gate built on a guess would also record `authEnabled: true`) and
  any value that is not `open` or `account-required`, and builds its byte-for-byte round trip for the
  same state it writes for. `scripts/reset-admin.js` passes it, and its Caddy modes send an armed
  install to `--store` instead of offering `--create-gate`.
- **Recovery codes go with the account's revocation.** `store.users#disable` deletes the account's
  codes with its sessions, and `#enable` deletes any left on a row disabled by other means — a revoked
  person's copy must not work when the account comes back. **`reset-admin.js --store` deletes them on
  a reset too**, for the reason it ends the account's sessions: a code copied by whoever took the
  password would reset it again the moment the run ends. The cost, stated: an operator who simply
  forgot the password loses their codes and generates a new set in Settings once signed in. The
  operator may veto this one; the disable/enable half is the plan's.
- **`reset-admin.js --store` reports the state a request meets**, `resolveGateState` over the config
  and the Caddyfile on disk (`caddy.readIngressDoor`, the reader the server's gate uses), not
  `authEnabled` alone — which said "NO login is enforced" on a caddy-mode install whose Caddyfile keeps
  the accounts deciding. It names Caddy's password when the file carries one, and a fallback marker
  when present (whether one is honoured depends on a request's socket, which a terminal has not got).
- **The sign-in page reads `gateState` from `/api/auth/me`** and, where a sign-in cannot succeed
  (`locked`, `unreadable`) or is not asked for (`fallback`, `open`), replaces the form with why and what
  to do. The recovery link is hidden in the markup and shown only for `armed`, so a page whose request
  failed stays the plain form without advertising `/recover`. Telling `locked` apart from a wrong
  password is visible to a signed-out caller; accepted, because `/api/auth/me` already reports
  `gateState` to one.
- **`docs/recovery.md`** is the in-repo walkthrough, generic where the operator's machine-local
  runbook is specific to one install; `SECURITY.md`'s login section describes TangleClaw's own login as
  the gate and Caddy's `basic_auth` as present only by state.

### Recorded during #1420 A-04d (2026-09-13) — the gate machinery

- **Whether the Caddyfile is a door is read through Caddy's own parser.** `lib/ingress-door.js`
  replaces the text walk the A-03 rule named: `caddy adapt` over the file's text, each top-level
  route walked in evaluation order with `lib/gate-fallback.js#walkRoutes` (the fallback check's
  walker, so the peer guard, the generator's gate route and TangleClaw's bypass-only routes read the
  same in both). A route that forwards before any gate is `unguardedLocalSite` when every host it
  matches is `localhost`/`127.0.0.1`/`::1`, and `ungatedRemoteSite` otherwise. A Caddy app beyond
  http/tls/pki, or named routes, reads as an ungated remote site. Every forwarding route counts, not
  only one dialling TangleClaw: the reader does not know TangleClaw's upstream, and over-reporting
  keeps a login on. Its own module because `caddy.js` requiring the walker would be a require cycle.
- **Stricter than A-03 on purpose.** `basic_auth` is weighed per site and in order, no longer "any
  credential line in the file". A site gated everywhere but one handle — the `/openclaw-direct/*`
  workaround — is now a door, so `authEnabled: false` no longer opens it and the accounts decide. Same
  direction as the fallback check; a wrong "door" keeps a login on.
- **A Caddyfile that imports another file is a door** without asking Caddy: the verdict is cached on
  the Caddyfile's own mtime and size, so an edit to the imported file would never be read. The
  fallback check refuses the same shape for the same reason.
- **When `caddy adapt` cannot read the file, it is a door.** No text walk decides. The first build
  kept the old text reader as a fallback, hardened toward "door"; its review showed a hand-written
  Caddyfile parser misreading `handle_errors` (Caddy runs error routes without the site's
  `basic_auth`) and carrying two documented limits on the "no door" side, for a question the fallback
  check already answers "refuse" when adapt cannot run. The cost, stated: a caddy-mode install with
  `authEnabled: false` whose TangleClaw process cannot run `caddy` (the service PATH trap) keeps its
  login on — the accounts decide, and with none the first-account page shows — until `caddy` is
  reachable. The log names the reason. An "unread" answer is re-asked every 30 seconds rather than
  held until the file changes, so a passing adapt timeout does not stick.
- **`caddy adapt` runs synchronously on the request path**, once per change of the Caddyfile and only
  in caddy mode with `authEnabled` off — the trade the fallback check already made, for the same
  reason: an asynchronous check needs a "not yet known" answer, which would have to count as a door.
- **One walk over an adapted config's top-level routes** (`gate-fallback#eachTopLevelRoute`) serves
  both the fallback check and the door, so a shape either learns to refuse (a plugin app, named
  routes, error routes) is learned once. Both now agree that a route with one matcher set lacking a
  host list matches any host; the fallback command probes such a route with no host as well.
- **`server.js#_gateIngress` reads the file itself after its `stat`**, so a Caddyfile gone between the
  two throws (`unreadable`, not cached) instead of being answered as missing and cached under the key
  of the file just `stat`ed. `ingress-door.readIngressDoor` keeps "missing is no door" for
  `reset-admin.js`, which has no cache.
- **One `server.js#_withHashSlot` owns the password-hash concurrency cap** — the check, the 503 with
  `Retry-After`, a warn line naming what was refused, the counter and its `finally` — for the login,
  the first-account page, a recovery-code redemption and minting codes. A test fails if the counter
  is touched anywhere else.
- **`recovery-codes#clientKey` returns `{ key, address, proxied }`** and asks
  `auth-identity#cameThroughProxy` whether the request came through the proxy, so there is one
  spelling of that check and the server no longer decodes a string prefix. The keys are unchanged.

### Recorded during #1420 A-VRF (2026-09-13) — a lost account store, and what the cutover defers

- **Reach authorises the first account only while the install has never had one.** A-02a's premise —
  `account-required` exists only before an install's first account, because no code path deletes a
  user row — does not hold outside the code: a corrupt `tangleclaw.db` deleted and recreated empty, or
  a database restored from before the first account. By then the cutover has written a Caddyfile with
  no `basic_auth` (TangleClaw was the gate), so the first-account page is the install's only key and
  any machine that reaches it can take it. Verified on the macOS VRF guest before the fix: with the
  database moved aside, a request from another machine created the only account.
  - Every account insert writes `~/.tangleclaw/accounts-established` (0600), and startup backfills it
    for accounts that predate it. A file beside the database, not a row or a config key, because what
    it must survive is losing the database.
  - While it exists, `POST /api/auth/set-password` takes the claim only from a direct loopback caller
    with no `X-Forwarded-For`; anyone else gets `403 ACCOUNT_STORE_LOST` naming
    `reset-admin.js --store`. A marker that cannot be checked answers `503`, never a claim.
  - Chosen over the Critic's alternative (refuse remote claims whenever the Caddyfile has an ungated
    site): the live install's hand-maintained Caddyfile has an ungated `/openclaw-direct/*` handle, so
    that rule would have refused the operator's own first account through Caddy's password at the
    cutover. The marker separates the two populations exactly: an upgrade has never had an account.
  - Not covered, accepted: a whole `~/.tangleclaw` replaced (or `TANGLECLAW_HOME` pointed at a fresh
    home) takes the marker with it. A fresh home also has a fresh config that has not finished setup.
- **Out-of-process Caddyfile tools find TangleClaw by the installed service's port**
  (`https-setup#installedServerPort`: the server plist's `TANGLECLAW_PORT`, else config). The VRF guest
  ran the fallback with config at 3101 and the service at 3102 — every standard install's shape — and
  the command judged an ungated file as gated. The server refused the marker, so the fail-safe held.
- **The dashboard's bind notice is derived per request** from the bind recorded at listen time and
  the request's gate state, so it agrees with `authStatus` in the same response.
- **Deferred, with issues:** changing an account's password from Settings with the current password
  (#1457) — ADR 0015 lists it as enabled by Tier 1; the cutover ships without it and the docs say so —
  and a command to disable an account (#1458): `store.users.disable` has no caller, so `locked` is
  reachable today only by editing the database.

### Recorded during #804 / #803 (2026-09-14) — the wizard's honest sentence, as built

OQ3's sentence ships, and the three call sites #804 names ask one question. The policy is ADR 0009
"Amendment 2026-09-14"; what the build settled beyond it:

- **Named facts, not a reused plan action.** The derivation takes `loginInHand`, `adoptionSupplies`
  and `caddyLoginInForce`. `plan.action === 'adopt'` had meant both "Finish will adopt a login" and "a
  Caddy login is in force", and Skip adopts nothing, so the probe ships Skip's answer separately
  (`credential.skipAllowed`) and the wizard shows Skip from it rather than from "the step is absent".
- **An unknown answer shows the login step.** Before, a failed probe hid it, because a password
  collected with nothing to enforce it was the worst outcome. The account now enforces on every
  install, so hiding it would finish an install with no login on a network blip. The choice of none is
  not shown until the server has offered it.
- **The wizard issues recovery codes** (A-04a deferred this here). Setup mints a set with the account
  and returns them once; the wizard shows them before any provisioning or restart screen, because a
  cutover started by the same response restarts the server.
- **Screens after setup read the gate state, not the cutover.** `account.loginInForce` on the
  completion response is `guardsTheDoor` of the state setup saved. A cutover that fails leaves the
  account armed, so its screen says Caddy was not put in front while the login still asks, rather
  than "nothing is asking for a password".
- **"Add a login" turns the switch on and creates nothing.** The first-account page already creates
  the account, signs the person in and shows codes, so the settings route does only `authEnabled` and
  `loginOptOutAt` and hands the browser to `/login`. It also serves an install whose account was made at
  a terminal while the login was off — the state `reset-admin.js --store` used to answer with "turn it
  on in Settings", a control that did not exist. `POST /api/auth/credential` changes a Caddy credential
  and never turns a login on. The record is cleared by construction rather than per route: `store.config.save` never writes `loginOptOutAt` beside `authEnabled: true`. A hand-listed set of call sites missed `reset-admin.js --create-gate` and Caddyfile adoption, both of which turn a login on.

### Recorded during #1753 (2026-09-22) — how a stood-down gate recognises the dashboard over plain http

**Architect-ratified 2026-09-22**, within the boundary below: honoured only when `tcGateActive === false`, ignored when armed or locked, never added to `isMachineClient`.

While the gate stands down (`open`/`fallback`), the caller resolver (`lib/shared-docs-access.js`)
treats a browser-shaped request as the operator. Browsers send `Sec-Fetch-Site` only to HTTPS and
localhost origins, and no `Origin` on a same-origin `GET`, so the direct-mode plain-http shape this
ADR supports (line 57) left the dashboard's reads resolving as `unbound`: public project rows, and
`403` on the groups and shared-docs reads. Its writes were never affected, because browsers send
`Origin` on every non-`GET` request.

- **The dashboard labels itself.** `tcFetch`, the one way the dashboard reaches the server, sends
  `X-TangleClaw-Client: dashboard` on every request, and the resolver accepts it as the operator
  **only while the gate stands down**. On `armed` or `locked` it is ignored; the session cookie is
  the only operator there.
- **It is a label, not a control.** Any local process can send it, exactly as it can send `Origin`,
  and with the gate down the whole dashboard is already open to whoever can reach it. It restores
  the operator's view; it adds no security and the code does not claim any. It is not added to
  `isMachineClient`'s browser test, so the fleet carve-out is unchanged.
- **Rejected: a `Referer`/`Accept` heuristic** (the issue's first option). It is no harder to forge,
  a referrer policy can strip `Referer`, and it would guess at a fact the dashboard can simply state.
- **Rejected: documenting the public view as expected.** The operator on a supported install shape
  would lose paths, git state and groups with nothing on screen saying why.
