# ADR 0015: TangleClaw owns authentication — the gate moves out of Caddy

**Status:** **Accepted (2026-09-11, operator-ratified in-pane).** Not built. The operator accepted the cost explicitly — 1-2 trains of work — to get a front door that works on any ingress mode, and a principal to hang per-user resource defaults on. `basic_auth` can provide neither: it is one shared credential, and it exists only in caddy mode.
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

**This ADR takes the identity half of that model and not the authorization half** — see the tier
split below. #1149 describes a full access-control system; what the operator asked for is a front
door plus per-user resource defaults. Where this ADR and #1149 disagree on scope, this ADR is the
narrower and is the one being built.

This ADR is not a reversal. It is the upgrade the 2026-06-24 decision reserved.

### What `basic_auth` structurally cannot do

One shared credential in a generated file. Not "does not yet" — cannot, without becoming a different
mechanism:

| Requirement | Tier | Under `basic_auth` |
|---|---|---|
| Per-person accounts | 1 | One credential for everyone |
| Revoke one person | 1 | Change the password for everyone |
| Logout, session expiry | 1 | Browsers cache Basic credentials per origin; there is no logout |
| Know *who* is asking | 1 | Every request is the same username |
| Per-user resource defaults | 2 | Nothing to attach them to |

**Every row that justifies this ADR is tier 1.** The tier-2 row is included only to show why it
needs tier 1 first: resource defaults have to hang on a principal, and `basic_auth` has none. It is
not itself an argument for moving the gate.

The fourth row is the sharpest. TangleClaw launches agent sessions with shell access, and a system
that cannot tell one person from another is not multi-user; it is a shared account. Note what that
row does **not** claim — an audit trail of who did what is a capability identity *enables*, not a
control this ADR commits to building.

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

## Two tiers, and only one of them is a security boundary

**Added 2026-09-11 from the operator's own framing, which reshapes this ADR's scope.** Their words:

> "we DO want to prevent hostile access… i do want us to be able to lockdown a tangleclaw system
> from auth vs non auth, and then a light layer for resource defaults is something i'm not worried
> about."

And their statement of intent, which is the clearest description of the product:

> "i'm the so called 'admin' who can add another resource user for example 'rosie' and i can limit
> what resources she has access to, create a UN/PW for her, which has a key for the front door and
> sets up what options i want her to be able to access once she's inside the house. and i can say
> for example, they can only see their own projects, or we could have a project that we're
> collaborating on that we both see."

**Tier 1 — the front door. The security boundary; full rigor.** Authenticated vs not, on **any**
ingress mode. This is what this ADR is for. Today the credential takes effect only in caddy mode
(`lib/store.js:133` — "the gate lives at Caddy"), so a direct-mode install has no login at all.
Closing that is the priority.

**Tier 2 — "resource defaults". A light layer, explicitly NOT a security boundary.** Which
engines/models a user may reach, cost caps, which projects they see. It is a guardrail against
expense and clutter among trusted people — not containment.

**Tier 2 is not authorization, and the ADR means that literally.** It is not a weaker authorization
layer, not authorization deferred, not authorization with a smaller threat model. It decides what
TangleClaw *offers* a user, and nothing about what they may *reach*. Four things follow, and they
are what stop this drifting back into an access-control system:

- **A tier-2 check never protects anything.** If removing one lets a user do something, that thing
  was relying on tier 2 for security and the reliance is the bug — the fix belongs in tier 1.
- **Bypassing tier 2 is not a vulnerability.** A user with a terminal can invoke any CLI by hand.
  That is expected and documented, not a hole to close.
- **It needs no authorization vocabulary.** No grants, no revocations, no delegation, no
  principal/action/resource triple, no resolver. Those were designed here while tier 2 was still
  believed to be a boundary, and they are over-built for a preferences layer (see open question 5).
- **It may not be the place any security decision is made.** If a route needs to refuse someone,
  it refuses at tier 1 against identity — never by reading a resource default.

**The dependency runs one way:** tier 2 needs identity, so tier 1 comes first. After that they share
no mechanism and can be built independently. **Tier 2 never gates a release** — a half-built engine
filter leaves nothing insecure, because the door still holds.

### Four rulings that constrain the build

1. **"Resource defaults" are CONSTRAINTS, not overridable.** The name says default; the requirement
   is that the other engines are "not available in the ui for her". A user who can switch off the
   default controls no costs. Read cold, "resource defaults" invites the overridable version, which
   loses the point entirely.
2. **"Only see their own projects" is a UI FILTER, not a wall.** A user with a terminal can `cd ..`
   into another project. The goal is tidiness and cost control among trusted people, not secrecy.
   Recorded because it is the sentence most likely to be misremembered later as a real boundary.
3. **Shared projects are a MEMBERSHIP, not a per-user field.** "A project we're both on" is a
   relationship, so `project_members` rather than `users.allowedProjects`. Cheap now, a migration
   later; it is the one piece of #1149's model worth taking immediately.
4. **Tier 2 is a guardrail, not containment — say so wherever it is surfaced.** A terminal user can
   invoke any CLI by hand. A resource default governs what TangleClaw *offers and launches for
   them*, never what they are able to reach.

### Requirements (the operator's, verbatim where it matters)

> "like lets say i want user A to have access as an ADMIN and user B to just have access to their
> own projects and or certain LLMs or certain usage limits…"

1. Granular RBAC — Admin vs User. **(Operator's word. In this ADR's terms it is tier 2 —
   "Admin" means the person who adds users and sets their resource defaults, not a privilege level
   that gates access. The only genuine tier-1 distinction is authenticated vs not.)**
2. Per-project scoping.
3. LLM usage limits.
4. Per-**user** rights and limits, not only per-role: "each user might have different rights or
   limits". So a role is a *default*, not the answer.
5. Per-user **model/engine** access — *which* LLMs, distinct from *how much*. The design point it
   carries: a user's resource defaults cover more than one KIND of thing (projects **and** engines,
   probably more later), so whatever record holds them should not be shaped as "a list of projects"
   with engines bolted on afterwards. That is a data-shape observation, not a permission-model one.
6. Per-user **harness type** (local `ttyd` vs a remote harness) — **future scope, not first train.**
   It makes hosted clients conceivable but does not by itself make them safe; see below.

### Out of scope, deliberately

**Hosted clients / multi-tenancy.** This follows from the operator's own architecture rather than
from a limitation: if tier 2 is not a security boundary, everyone past the front door is trusted.
That works for a partner, a collaborator, or a vetted contributor, and is incompatible with
strangers. Requirement 6 would close the *direct* path (no local shell) but not the *indirect* one —
`PUT /api/rules/global` (`server.js`) writes rules that TangleClaw injects into the engine config a
**trusted** session then reads and obeys, and `_buildBaselineHooks` (`lib/engines.js`) writes shell
command strings. Hosting strangers therefore requires auditing and default-denying every
host-affecting route, which is a different product tier and needs its own ADR.

## Decision

**TangleClaw authenticates its own requests. Caddy terminates TLS and stops being the gate.**

Sessions are established by TangleClaw against a user store TangleClaw owns, using **scrypt** from
Node's standard library.

**This adds no dependency.** TangleClaw already ships the primitives — when this was written they
sat in `lib/projects.js` guarding project deletion; the Train 9 build moved them to their own owner,
`lib/password.js`:

```js
crypto.scryptSync(password, salt, 64)  // hash, random per-user salt
crypto.timingSafeEqual(...)            // verify, constant-time
```

ADR 0012 (enforcement adds no install step) is satisfied: no `xcaddy`, no Go toolchain, no
single-maintainer Caddy plugin on a rebuild-on-security-bump treadmill — which was Path B's real
cost and the reason it lost in June.

### Why not Path B (caddy-security) now that multi-user is real

It would deliver sessions and multi-user, but it gates **at the proxy** — and tier 1's requirement is
a front door on **any ingress mode**. A direct-mode install has no proxy, so Path B cannot protect
the population this ADR exists for. That alone settles it.

Two supporting reasons. A proxy that establishes identity is a second source of truth about who the
caller is, and this project has a standing position on those. And tier 2 needs a principal to hang
resource defaults on, which means TangleClaw has to know the user regardless — so having something
else establish that identity buys a dependency and no capability.

**Note this argument deliberately does not rest on authorization.** An earlier draft argued that
#1149 puts authorization in TangleClaw's data model and the proxy therefore cannot own it. That
reasoning is retired: tier 2 is not authorization, so it cannot carry an argument about where
authorization belongs. The ingress-mode argument above is the real one and it is stronger.

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
  *(Decided during the build: ADR 0016, "Recorded during #1419" — TangleClaw's gate does not
  honour this exemption, because TangleClaw injects the gateway token on that proxy.)*
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

## Answered since this ADR was written (2026-09-11)

- **Who the users are:** collaborators, and trusted people the operator adds (their example: a
  partner given an Aider-only account to control spend). Not hosted strangers — see Out of scope.
- **Usage limits, enforce or report:** a setting, recommended values `warn` /
  `block_next_turn` (default) / `hard_stop`, evaluated at **turn boundaries**. Never kill mid-turn:
  an agent interrupted mid-edit leaves a broken tree and a half-written file, trading a cost
  overrun for corrupted work. "Let it finish" means finish the *turn*, not the session.
- **Delegation:** a user may grant access to their own resources. Two rules from day one — a user
  can never grant a right they do not themselves hold (else delegation is a privilege-escalation
  path), and granted access is **not** re-grantable (cap at one hop, or "who can reach this
  project?" needs a graph walk and revocation becomes a cascade).
- **Can a non-admin start a session:** yes, on their own projects. Which is exactly why tier 2 is
  documented as a guardrail rather than containment — the session is a shell as the host's OS user.

## Open questions for the build

> **OQ1, OQ2, OQ3 and the migration mechanism were answered on 2026-09-11 by
> [ADR 0016](0016-tier-1-auth-build-decisions.md), at the start of the Train 9 build.** They are
> left below as written, because the reasoning that follows is why they were open. Read 0016 for
> what was decided. **OQ4** is settled (#804 is chunk 05). **OQ5 is still open** and is deliberately
> not answered by 0016.

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
5. **What shape does tier 2 actually take?** Not *whether* it is authorization — it is not, and the
   tier split settles that. The open part is construction: a per-user preferences record (a field
   for which engines a user sees, and a UI that filters on it) is almost certainly enough, and the
   permission resolver with grants, revocations and delegation sketched during design is over-built
   for it. Decide before building tier 2, and default to the simpler shape.
