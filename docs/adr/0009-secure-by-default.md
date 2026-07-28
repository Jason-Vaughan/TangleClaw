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

**An operator-managed Caddyfile must be preserved.** Automated provisioning either preserves a
hand-edited config or refuses; it never clobbers one (the refuse-to-ungate guard from #463 is the
existing precedent).

**Why this ADR exists at all.** The superseded posture was written down — in a project artifact under
`.prawduct/`, which is gitignored. It was therefore invisible to a fresh clone, to contributors, and
to review. A security posture that only exists on one machine cannot be checked, inherited, or
argued with, which is precisely how it went stale unnoticed. Durable decisions belong in tracked
ADRs; `.prawduct/artifacts/security-model.md` now points here rather than holding the decision
itself.
