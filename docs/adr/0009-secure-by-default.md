# ADR 0009: Secure by Default — a password out of the box, opt-out not opt-in

**Status:** Accepted (2026-07-27). Operator-ratified. Supersedes the VPN-as-perimeter posture recorded in ADR 0003 and the "optional login" framing of ADR 0004.
**Source issue:** #710 — reach HTTPS + a login gate from a standard install. This ADR settles that issue's standing design question.
**Builds on:** ADR 0003 (ingress model), ADR 0004 (AUTH-2 Caddy `basic_auth` gate), ADR 0005 (service tokens).

---

## Context

TangleClaw's authentication was built at the Caddy ingress and treated as **optional**, justified by
a VPN-as-perimeter assumption: the operator reaches TangleClaw over a personal Tailscale/WireGuard
tunnel containing only their own devices, so application-level login is a defence-in-depth extra
rather than a requirement.

That assumption was reasonable for a single-operator tool and it **expired the moment TangleClaw had
an outside installer**, without anything forcing a re-examination. Measured on a first-time install
(2026-07-26):

- `lib/store.js` — `ingressMode: 'direct'` and `authEnabled: false` are the shipped defaults.
- `public/setup.js` — the wizard's admin-credential step is appended **only** when
  `ingressMode === 'caddy'`, so a default install never collects a credential.
- `server.js` — `const bindHost = caddyMode ? '127.0.0.1' : null` — with caddy off, Node binds every
  interface.

The net result of those three defaults, none of which is wrong in isolation, is an **unauthenticated
dashboard reachable across the installer's network**. TangleClaw launches AI agent sessions with
shell access, so that is arbitrary code execution as the operator, plus read access to every managed
project and any credential those projects hold.

`README.md` already carried "run behind a VPN" and "do not expose to the public internet" guidance
before that install happened. It changed nothing.

## Decision

**A TangleClaw install is protected by a username and password out of the box. The operator may turn
that off; they never have to turn it on.**

1. **The ingress becomes part of the install.** The setup wizard provisions and configures the gate
   rather than leaving it to a separate manual cutover. This resolves #710's fork — the alternative,
   giving direct mode its own independent login, was rejected because it means maintaining two
   authentication paths and therefore two sets of assumptions that can drift apart. One path is the
   whole point of this ADR.

2. **No default credential, ever.** The credential is *forced at setup*, never shipped with a value
   the operator is prompted to change later. **This repository is public**, so any default would be
   readable by anyone and every install would be pre-compromised from first boot until the operator
   acted. A change-me prompt does not close that window; prompts get dismissed, and a fresh install
   is exactly when nobody is watching. Forced-set costs the same single wizard step and has no
   window. `ADMIN_REQUIRED` — already enforced on both `/api/setup/complete` and the
   `PATCH /api/config { setupComplete: true }` Skip path — is now a requirement rather than an
   implementation detail of caddy mode.

3. **Loopback unless something is guarding the door.** Binding beyond `127.0.0.1` requires either the
   gate or an explicit, recorded opt-in — never a silent consequence of skipping setup. Where the
   gate cannot be provisioned, the install degrades to loopback-only. It must never degrade to the
   current state: no gate *and* a wide binding.

4. **A settings surface may change the credential, never blank it.** Two routes to "no password" is
   one more than this ADR allows; the only unprotected state is the deliberate opt-out.

5. **Recovery proves physical control and lives outside the gate.** Break-glass is a terminal tool on
   the machine (`scripts/reset-admin.js`), never a dashboard feature — a reset behind the gate cannot
   help the person the gate locked out. Being on the box is the authorization, which is the correct
   bar: local shell access already confers everything TangleClaw could give. An AI assistant running
   locally may perform it. This deliberately opens no second remote door.

6. **Internet exposure is unsupported**, not merely discouraged. A single shared Basic credential
   with no rate limiting, lockout, second factor, or session revocation is too thin a margin in front
   of arbitrary code execution. Supported perimeters: loopback, a private tunnel, or a trusted LAN
   behind the gate.

## Consequences

**Documentation is not a control.** Any proposal of the form "document that the operator should…"
does not satisfy this ADR. The guidance in `README.md` stays and gets sharper, but the *default* is
the enforcement.

**A third-party binary becomes an install-time dependency.** This is the real cost of choosing the
ingress over a built-in login, and the install must fail honestly when it cannot be satisfied —
degrading to loopback-only, saying so, rather than silently landing in the old unsafe state.

**Changing the bind default is breaking.** A direct-mode install reached from another device today
goes dark. It ships with an explicit opt-out and an upgrade notice, never as a bare default flip.
Removing someone's remote access without warning is the same class of failure as shipping them no
password.

**Amendment (2026-07-28) — the two listeners close on different schedules, and the dashboard's
closure is interlocked with the gate.** The paragraph above was written when the author was the only
installer, so "goes dark" was a cost only he would pay. With outside installs in the field it is a
support incident delivered by an update button, and the ADR's own retroactivity clause — *existing
installs must not break silently, they get an upgrade path* — is better served by sequencing than by
a notice. Three rules:

1. **The terminal listener (ttyd) is pinned immediately, for everyone.** No client addresses it
   directly — TangleClaw proxies to `127.0.0.1:<ttydPort>` and the browser loads a relative
   `/terminal/` URL — so pinning it is invisible to every existing operator. It is also the more
   dangerous of the two doors, being a `--writable` terminal that execs `tmux attach-session`. A
   change that removes an unauthenticated shell at zero cost to the user is not one to stage behind
   anything.
2. **The dashboard listener narrows when a gate is in front of it — established by ingress mode, not
   by request identity.** The binding is chosen once, at `listen()`, where no request exists;
   `authStatus === 'live'` (`lib/auth-identity.js`) is request-scoped and therefore cannot be
   consulted there. The implementable equivalent is `ingressMode === 'caddy'`, and it is not a
   weaker proxy: the credential gate exists *only* in caddy mode, so caddy mode is the necessary
   condition for a gate to be in front of anything, and caddy mode already pins loopback for its own
   reasons. An install that never had remote reach (no prior wide bind) narrows immediately, because
   nothing is taken away.

   What this concedes, stated plainly: an install in caddy mode with `authEnabled: false` narrows
   without a password ever being set. That is not a regression — it is loopback-only, which is the
   safe state — but it is not the "gate proven live" the first draft of this clause promised.
   Proving the gate live belongs to chunk 2, where provisioning verifies the credential answers
   through the ingress before trusting it.
3. **Until then the install keeps its binding and says so, loudly and repeatedly.** This is a
   deliberate, bounded exposure window, not an acceptance of the old posture: the grace state exists
   only to keep an operator reachable long enough to *reach the thing that fixes it*.

The interlock is what makes this safe without coordination: the door closes only after a working
lock is on it, so there is no ordering for an operator to get right and no window where they are
stranded. Provisioning the credential must verify the gate answers through the ingress before
trusting it, and roll back automatically if it does not — a cutover that half-succeeds on a remote
machine is the failure this amendment exists to prevent.

**Caddy mode refuses the opt-in rather than honoring it.** Where the gate is in front, binding the
server to every interface as well would publish an ungated door *beside* the gated one — strictly
worse than direct mode, because the operator believes they are protected. The setting is not
silently ignored there: the refusal is logged, and the settings control is locked and rendered from
the resolved binding rather than the stored value, so the config can never appear to claim something
the socket does not do.

**"Never chosen" is a recorded value, not an inferred absence.** The population held in grace is
identified by its config predating the setting — but that absence survives exactly one config write,
because loading merges defaults and saving writes the whole object. Left inferred, an operator
changing their theme would have ended their own grace period and lost remote access at the next
restart. It is therefore converted once, at boot, to an explicit `null` distinct from both `true` and
`false`; the config API accepts only booleans, so `null` cannot arrive from outside and means exactly
one thing. Any surface that must distinguish "has not chosen" from "chose to close" reads that value
— never the key's presence.

**One derivation, server-side.** What the binding is, what the operator recorded, and whether the
control should be locked are answered in one place and shipped to the frontend. Three separate
defects in the first slice were two copies of these rules disagreeing, each surfacing as a control
that misdescribed the socket. Consumers render the answer; they do not restate the rules.

**An operator-managed Caddyfile must be preserved.** Automated provisioning either preserves a
hand-edited config or refuses; it never clobbers one (the refuse-to-ungate guard from #463 is the
existing precedent).

**Amendment 2026-07-29 — "preserve or refuse" is not enough on its own, and the wizard gets no
override.** The clause above is satisfied by a user interface that asks "overwrite your existing
config?" and proceeds when the operator clicks yes. That is not the intent, and stating only the
weaker rule left the stronger one unwritten and therefore unenforceable. Made explicit:

- The setup wizard **never writes a Caddyfile that a human maintains** — not with a confirmation, not
  behind an "advanced" disclosure, not at all. It offers **no equivalent of the CLI's `--force`**.
- Where a hand-maintained config already carries exactly one credential **and Caddy is the active
  ingress**, the wizard **adopts** it — reads it into canonical config, read-only on the file — and
  reports that it kept the operator's existing login.

  **Amended 2026-07-29 while building:** the original clause said only "already carries exactly one
  credential", and that is not sufficient. A Caddyfile is a file; a *gate* is a running process. On a
  direct-mode install the file is a config nothing is serving — a shape
  `scripts/ingress-cutover.js --rollback` produces routinely, since it unloads Caddy and restores
  `ingressMode: direct` while leaving the Caddyfile on disk. Adopting there would set `authEnabled`
  on an install with nothing in front of it, which is the false-claim-of-protection this ADR exists
  to forbid, arrived at from the opposite direction. So adoption requires the live ingress, and
  otherwise **refuses** with the reason. The same reasoning already governed the caddy-binary-absent
  case; it was simply not carried across to the ingress-mode case.

  A third case, from the same build: when the operator supplies a credential on a machine whose plan
  was to adopt — reachable, because the Skip route refuses in caddy mode without a configured
  credential and the wizard then forces the admin step — the typed credential lands in config while
  the hand-maintained Caddyfile goes on enforcing the adopted one. Two credentials then disagree and
  the operator's new password does not work. The wizard reports the **mismatch**, names the account
  they set rather than the adopted one, and routes them to `scripts/reset-admin.js`, which rewrites
  the live config too. It does not report "kept".

  A second amendment from the same build: the wizard may only report "kept your existing login" when
  adoption **actually adopted**. Credential adoption deliberately never overwrites a credential
  already in config, so on an install that has one the call is a no-op while the hand-maintained file
  may enforce a *different* credential — reporting success from a config predicate would make exactly
  that drift invisible. That case reports a distinct, honest state instead.
- Where it carries several credentials, or none, or cannot be read, the wizard **refuses and routes
  the operator to `scripts/ingress-cutover.js`**, where `--force`, `--rollback` and a timestamped
  backup exist. Destroying a working gate stays a deliberate act taken at a terminal, with an undo.

The reasoning is the same as the no-default-credential rule: a prompt that can be clicked through
during first-run setup is not a control. The difference from the CLI is not trust in the operator, it
is that the terminal path carries a backup and a rollback and the browser path carries neither.

Recorded here rather than in the build plan because build plans are deleted when their work ships,
and `.prawduct/` is gitignored — the same failure mode this ADR's closing paragraph describes.

**Why this ADR exists at all.** The superseded posture was written down — in a project artifact under
`.prawduct/`, which is gitignored. It was therefore invisible to a fresh clone, to contributors, and
to review. A security posture that only exists on one machine cannot be checked, inherited, or
argued with, which is precisely how it went stale unnoticed. Durable decisions belong in tracked
ADRs; `.prawduct/artifacts/security-model.md` now points here rather than holding the decision
itself.
