# Train 9 · Chunk 05 — A2: "a credential is mandatory here" once (#804), the honest opt-out (#803)

**Issues:** #804, #803. **Sprint:** v5.24, Session 6 (plan of record:
`/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder/.tangleclaw/plans/sprint-v5.24.md`).
**Branch:** `feat/804-803-credential-required-and-opt-out` off `main`, **one PR for both chunks** —
`main` is the live install, and A2a alone would leave the wizard routing a no-Caddy install through
the server-forced login step with a summary that calls it unconfirmed. Reviewed per chunk; cumulative
before the PR.
**Design of record:** ADR 0009 rules 2–4; ADR 0016 OQ3 ("the wizard finally gets an honest sentence"),
"Recorded during #1420 A-02a" (what #803/#804 still own), A-04a (wizard code issuance is #803).
**Ruling that governs #803:** 2026-09-10 — the wizard MAY finish ungated; a login is addable later from
global settings (memory `project_803_ungated_wizard_ruling`; recorded in ADR 0016 OQ3). It supersedes
the 2026-09-02 descope comment on #803. Two ADR 0009 constraints ride with it: the ungated state is an
**explicit, recorded opt-in**, and it never means **no gate AND a wide bind**.

**Requirements Confidence:** High for #804 (one derivation, three consumers, the uniformity test).
Medium for #803's UX (the ruling fixes the policy; the choice's placement and wording are Builder
decisions, vetoable, listed below).

## What changed since the issues were filed

Both issues describe a Caddy-era world. After #1420 the login is TangleClaw's own (scrypt accounts,
`lib/auth-gate.js#resolveGateState`), so it can be enforced on **every** install — Caddy or not. The
three call sites still ask "can Caddy be provisioned here?" (`plan.action === 'provision'`,
`ingressMode === 'caddy'`, the bcrypt `basicAuthUser`/`basicAuthHash` triple). Consequences today:

1. A fresh install with no Caddy binary finishes setup `open` — no login step shown, nothing recorded.
   ADR 0009's "a password out of the box" is not true for it, though nothing prevents it any more.
2. Account creation in `POST /api/setup/complete` is gated on `caddy hash-password` (500 `HASH_FAILED`
   with no binary) although the account itself needs no Caddy.
3. The Skip guard and both `ADMIN_REQUIRED` checks treat "has a credential" as the bcrypt triple, not
   the gate state.
4. There is no recorded "the operator chose no login" — `authEnabled: false` is also the shipped default.
5. An opted-out install has no in-product way to add a login later (`/api/auth/credential` refuses in
   direct mode; `PATCH /api/config` refuses `authEnabled`; only `reset-admin.js --store` at a terminal).
6. Stale copy: after a provision whose cutover fails, the gate is already `armed` (account created),
   yet `server.js` and `public/setup.js` say "nothing is asking for a password".

## Decisions (Builder, vetoable)

- **D1 — Meaning of the predicate.** `credentialRequired` = setup may not finish unless, after it, the
  gate enforces (`authEnabled` on, or an adopted Caddy login) **or** the operator made the recorded
  opt-out **and** the opt-out is permitted here. It no longer depends on Caddy being provisionable.
  One pure derivation (`lib/setup-credential.js#decideCredential`, facts in → `{ required,
  optOutAllowed, optOutRefusal }` out); both server routes consult it through one fact-gatherer
  (`server.js#_decideSetupCredential`), and `GET /api/setup/ingress-state` ships its answer so
  `public/setup.js` reads it and derives nothing. **As built (A2a review):** the facts are named —
  `loginInHand`, `adoptionSupplies`, `caddyLoginInForce` — rather than read off `plan.action`, which
  meant two things. The one fact the routes legitimately differ on is `adoptionSupplies` (Finish
  adopts a working Caddy login; Skip adopts nothing), so the probe ships Skip's answer as its own
  `skipAllowed` and the uniformity test pins where the two differ.
- **D2 — Behaviour change, stated:** a fresh install with **no Caddy** now gets the login step by
  default (direct mode, loopback, TangleClaw account). This is ADR 0009's default reaching the
  population the Caddy coupling excluded; the opt-out below is its way out.
- **D3 — The opt-out is explicit and recorded.** A choice on the login step ("Finish without a
  login"), with the consequence sentence from ADR 0016 OQ3: *anyone who can reach this address is in*.
  Submitted as `noLogin: true` on `POST /api/setup/complete` only; recorded as
  `config.loginOptOutAt` (ISO timestamp, `null` default). Header **Skip** does not opt out: while a
  credential is required it routes to the login step (existing `_recoverToAdminStep`), and the PATCH
  guard refuses as today.
- **D4 — Never ungated AND wide, never a false choice.** The opt-out is refused (`OPT_OUT_REFUSED`,
  reason named) when a login is already in hand or a caddy-mode Caddyfile carries one
  (`LOGIN_IN_FORCE`); on a wide bind (`WIDE_BIND`); and in caddy mode when the Caddyfile has an
  ungated remote site, a `localhost` site with neither a gate nor the peer guard, or cannot be read by
  Caddy's parser (`UNGATED_REMOTE_SITE`, `UNGUARDED_LOCAL_SITE`, `DOOR_UNREAD`). **Stricter than the
  request gate on purpose:** the gate keeps `authEnabled: false` open over an unguarded `localhost` site
  on a no-account install (the 2026-09-13 ruling, for installs already in that state), but setup is
  where the operator makes a NEW choice on TangleClaw's word that it is safe, so it is not offered there.
  The step then offers only the login.
- **D5 — The account needs no Caddy.** The bcrypt hash is written whenever `caddy hash-password`
  answers (the fallback break-glass rebuild still needs it); a hashing failure is still refused where
  Caddy was detected, and skipped where it was not. The account is always created.
  "Has a credential" everywhere in setup reads the gate state / accounts, never the triple.
- **D6 — Recovery codes from the wizard.** After the wizard creates the account, mint a set
  (`store.recoveryCodes.replaceForUser`, degrade to `null` on failure like `set-password`), return
  them on the complete response, and show them once — before any provisioning/terminal screen
  (the cutover restarts the server).
- **D7 — Add a login later.** Global settings gets "Add a login" on an install whose gate is `open`
  with no accounts: sets `authEnabled` and creates the first account (+ codes) in one route, allowed
  only in that state. Reach authorises it for the same reason it authorises the first-account screen
  (ADR 0016 A-02a): whoever can reach an `open` install already has the shell. Clears `loginOptOutAt`.
- **D8 — Honest copy.** Every screen/response that says whether a password is asked reads the gate
  state the server computed, not the cutover outcome. `ingress.protection` gains `account` (TangleClaw's
  own login guards the door), classified as confirmed by `deriveProtectionFlags`.
- **D9 — The Skip guard is first-run only** (`wasSetupOpen`), like the engine guard beside it. Once a
  no-Caddy install can be refused, a completed opted-out install re-sending `setupComplete: true` must
  not be.
- **Norm amendment, not drift:** `security-model.md` § Direction ("setup forces the credential") is
  amended to carry the 2026-09-10 ruling and D3/D4 — recorded as a ruling, in A2b.

## Out of scope

- Turning a login OFF from settings (ADR 0009 rule 4 forbids blanking; recovery stays the terminal).
- Tier 2 (ADR 0015 OQ5), multi-user management, `networkExposed` for Caddy's own listener (file if
  it matters — Caddy mode never reports `wide`).

## Chunks

### Chunk A2a — the predicate and the server (#804, server half of #803)
- `lib/setup-credential.js` (pure) + unit table.
- `server.js`: PATCH Skip guard, `POST /api/setup/complete` (D1, D3 record, D4 refusal, D5, D6 mint),
  `GET /api/setup/ingress-state` ships `credential`.
- The uniformity test #804 asks for: a new fact reaching one route reaches the others (drive both
  routes + the endpoint off one fixture table).
- Stale server copy (D8, server side).
- **Done when:** suite green, mutation-checked guards, chunk Critic clean.

### Chunk A2b — the wizard, settings, docs (#803 client half)
- `public/setup.js`: login step reads `credential`; opt-out choice + consequence + refusal display;
  codes shown once; summary/unprotected/provisioning copy (D8).
- Settings "Add a login" (D7) — route + UI. **Every path that turns a login on clears
  `loginOptOutAt`** (A2a review R-7): the D7 route, `scripts/reset-admin.js --store`, and
  `POST /api/auth/credential` if it can reach an opted-out install.
- Render `ingress.user` only as the server names it — null when setup kept an existing account.
- Docs: ADR 0009 amendment (opt-out mechanism; the stale "only in caddy mode" line), ADR 0016 note,
  ADR 0015 status → Built, `docs/setup-guide.md`, `docs/user-guide.md`, `README.md`, `FEATURES.md`,
  `docs/auth-status-surfacing.md`, CHANGELOG.
- **Done when:** suite green, cumulative Critic clean, live check in a real browser on a scratch
  `TANGLECLAW_HOME` (login path, opt-out path, refusal when wide, add-later), #803 + #804 closed by PR.

## Status

- [ ] Chunk A2a — predicate + server routes
- [ ] Chunk A2b — wizard, settings "Add a login", docs
