# Train 9 · Chunk 04 — the Tier 1 cutover (#1420), A-series build plan

**Issue:** #1420 (closes #1055). **Sprint:** v5.24, Lane A.
**Design of record:** ADR 0016, "Addendum (2026-09-13, Checkpoint 1)" and its "The ruling" section. Read both first.
**Integration branch:** `train-9/cutover`, cut from `origin/main` at or after `e471cae9`. Each A-chunk
is a feature branch merged INTO `train-9/cutover`, never into `main`. Only the final cumulative merge
reaches `main`, and only at Checkpoint 2.
**Builder:** the TangleClaw-Builder session itself. Never a subagent (sprint plan, Lane A).
**Requirements Confidence:** High for A-02/A-03 (the issue's acceptance list, ADR 0015/0016 and the
Checkpoint 1 ruling fix the behaviour; Caddy's header handling is verified, not recalled). Medium for
A-04's fallback command and recovery-code UX (shape ruled, details open) and for A-VRF (depends on
the live elkaholic install).

## Gates

- **Checkpoint 1 (after A-01): RULED 2026-09-13, "1 + 2"** — terminal recovery stays; one-time
  recovery codes reset the password; ADR 0009 rule 5 amended. Recorded in ADR 0016 and on #1420.
- **Checkpoint 2 (after A-04):** cumulative Critic clean, elkaholic VRF PASS, both recovery drills PASS
  **from the operator's phone** (code reset + broken gate over SSH), and the operator says "merge". A relayed or inferred go is not one.

## Chunks

### A-01 — discovery + design (this document)
- ADR 0016 addendum: the kill-switch options, the migration state machine, state-driven `basic_auth`,
  and the `isMachineClient` revisit.
- This plan. → **Checkpoint 1.**

### A-02 — the state machine and TangleClaw's side of the door

**Split into A-02a (enforcement) and A-02b (identity display), one review each.** One review over
both would cover the gate, a new pre-gate write route, the carve-out, and the dashboard's identity
and status surfaces, and a Critic's attention degrades across a diff that wide. A-02a changes who
gets in; A-02b changes what the dashboard says about who is in. A-02b depends on A-02a's classifier.

**A-02a:** the classifier, `evaluate`/`evaluateUpgrade` on it, `isMachineClient` + no
`X-Forwarded-For`, and the set-password route + page.
**A-02b:** OQ2 (the inbound `X-Auth-User` deletion and the `lib/auth-identity.js` inversion),
`currentUser` / `sessions.owner` from the session, and `authStatus` re-derived from the classifier
(its `configured-no-identity` / `configured-bypassed` values have no meaning once nothing reads the
proxy header), plus the dashboard consumers of those values.

**Recorded during A-02a (2026-09-13): Caddy's `X-Forwarded-For` behaviour is VERIFIED, not recalled.**
A throwaway Caddy v2.11.4 (`admin off`, `auto_https off`, h1 pin) in front of an echo upstream, in both
shapes (a plain `reverse_proxy` and one with `header_up X-Auth-User`), set `X-Forwarded-For` on every
proxied request and REPLACED a client-supplied value (`X-Forwarded-For: 10.9.9.9` arrived as `::1`) on
both. Neither the live Caddyfile nor the generator sets `trusted_proxies`, which is what would make
Caddy honour a client's value.

**A-02a decisions (2026-09-13).**
- **The closed state is "no account exists", with or without a bcrypt hash.** ADR 0016's
  `credential-migration-required` requires a `basicAuthHash`, but `authEnabled` + no hash + no account
  would otherwise stay DORMANT, which is an open door once Caddy's gate is gone. It is the same
  situation (no key yet), so it gets the same answer. The state is named `account-required`. Five
  states: `open` (`authEnabled` not exactly true), `account-required` (no user row), `armed` (an
  enabled account), `locked` (accounts exist, none enabled: closed, recovered by terminal or recovery
  code), and `unreadable` (a store or config read failed: ENFORCES). This overrides the addendum's
  deferral of the no-hash case to #803/#804.
- **Reach authorises the set, as ADR 0016 says — no extra rule.** User rows are never deleted by any
  code path (only `disable`), so `account-required` exists only before an install's first account.
  Anyone who can reach the screen in that state could already reach an ungated dashboard, or had
  already passed Caddy's gate. That holds even for a direct-mode install with a wide bind. An earlier
  draft of this plan restricted the route by socket and `X-Forwarded-For`; that restriction bought
  nothing and would have locked a wide-bound direct install out remotely.
- **The first account is created atomically.** A new `store.users.createFirst` refuses when any row
  exists, inside `BEGIN IMMEDIATE`, so two concurrent submissions (or one racing
  `scripts/reset-admin.js`) cannot both create a first account.
- **Fallback is not in A-02a.** The `fallback` state lands with its command in A-04, where its
  "door observably present" check is built, rather than as unreachable code now.
- **The wizard creates the account (Critic R-1).** `POST /api/setup/complete` creates the first
  TangleClaw account from the credential it was given and signs the wizard in; setup that ends with no
  account (adopt, Skip) reports `account.required` and `public/setup.js#dismissWizard` sends the
  operator to `/login`. Without this the wizard locked itself out as it finished.
- **The first-account route hashes asynchronously** inside the login concurrency cap
  (`store.users#createFirstAsync`) — it is reachable signed-out (Critic R-2).

**Carried out of the A-02a review, into the chunk that will touch the code anyway:**
- ~~A-02b: `gateActive` means "enforcing" on `/api/auth/me` but `resolveAuthStatus`'s flag means
  "armed".~~ **Done in A-02b** — `resolveAuthStatus` takes the gate state itself, so the second
  meaning is gone; `gateActive` on `/api/auth/me` keeps "enforcing".

**Done in A-02b (the verify-resolutions and PR-review observations carried from A-02a):**
- set-password answers `503 GATE_UNREADABLE` in `unreadable` (it had said "an account already
  exists"); `ACCOUNT_EXISTS` stays for `armed`/`locked`, which do have accounts.
- The provisioning screen tells the operator they sign in once at the new address with the password
  they just set.
- The stale `lib/auth-identity.js` comment is gone with the rewrite.
- **Accepted, not changed:** `dismissWizard` became async and its three callers do not await it.
  Its only awaited step (`_installNeedsAccount`) never rejects, and the rest of its body is the same
  synchronous DOM work that already ran unawaited before; awaiting it at the callers would change
  nothing a caller does next.

**Carried out of the A-02b review:**
- A-03: `lib/auth-identity.js#isProxyHeaderTrusted` justifies trusting `X-Forwarded-Host` by Caddy's
  `basic_auth` gate standing in front. When A-03 drops that gate on an armed install, re-state (or
  change) the condition the forwarded host is believed under — it names an address in hidden model
  context, not an identity, but its stated reason goes away.
- A-03 (verify-resolutions observations, prose only): `lib/session-ownership.js` and `lib/store.js`
  still describe `owner` as the "proxy-authenticated user (null in direct mode)", and so does FEATURES'
  "Session ownership" entry; `lib/caddy.js#_pushSiteBlock`'s JSDoc mentions AUTH-3 forwarding without
  saying the header is inert. A-03 rewrites `lib/caddy.js` anyway.
- A-03 (PR review note): `lib/auth-identity.js` comments narrate history — the module header's "no
  longer interprets", `isProxyHeaderTrusted`'s "Identity no longer answers to this", and
  `resolveAuthStatus`'s paragraph on the retired `configured-*` values. Delete those clauses when
  `isProxyHeaderTrusted`'s justification is rewritten; the history lives in ADR 0016 and
  `docs/auth-status-surfacing.md`.
- A-03: `POST /api/setup/complete` answers `account.required: false` when the gate is `unreadable`, so
  the wizard moves on rather than surfacing the fault (the gate still enforces — nothing is exposed).
  Decide whether setup should refuse to finish on an unreadable gate, and test it.
- A-04: `SECURITY.md`'s login section still describes Caddy's `basic_auth` as THE gate. Its identity
  bullet was corrected in A-02b; the section is rewritten with the recovery doc, when the new door's
  recovery exists to describe.

**A-02b decisions (2026-09-13).** Recorded in ADR 0016 "Recorded during #1420 A-02b": the header is
deleted on both transports, logged at debug when it came through a proxy (Caddy's transitional
`header_up`) and at warn when it did not — a departure from OQ2's "logged at warn"; identity and
`owner` read the session; `authStatus` is the gate state; `isProxyHeaderTrusted` stays for the
forwarded host.
- A-03: the drift check reads the LIVE Caddyfile for `trusted_proxies` and any `header_up` touching
  `X-Forwarded-For`, and reports either as divergence — the carve-out's premise.
- A-04: the login page tells a `locked` or `unreadable` install apart from a wrong password (the
  recovery doc and the page copy land together); `unreadable` logging an error per request is kept,
  because a gate that cannot read its own state is the thing an operator must see.
- A-VRF: re-verify Caddy's `X-Forwarded-For` behaviour on the live Caddy version, and confirm nothing
  else local (Tailscale Serve, nginx, cloudflared) is pointed at TangleClaw's port.


- `lib/auth-gate.js`: replace the dormancy predicate with the state classifier (see the A-02a
  decisions above); one owner, read by `evaluate` and `evaluateUpgrade`.
- The set-password screen and route for `account-required`, applying `caddy.validateAdminPassword`,
  using the async scrypt path (`store.users#createFirstAsync`), retaining `basicAuthHash`.
- `isMachineClient` gains "no `X-Forwarded-For`". **First step: verify Caddy v2.11.4 sets and replaces
  the header**, against a generated and a hand-edited-shape Caddyfile on a PortHub-leased 5000+ port.
  If it does not, stop and re-open the carve-out decision; do not build on the recall.
- OQ2: delete inbound `X-Auth-User` at request entry with a warn; `lib/auth-identity.js` retargeted to
  the session ("forged header refused" replaces AUTH-3's "configured-no-identity");
  `activity_log` user from the session.
- Covers both transports and `server.js#peerReadTarget` (added by #918 behind the roster gate).
- Tests: every state × HTTP/upgrade × machine/browser/proxied; mutation-check each new guard.

### Chunk A.03 (A-03) — Caddy's side: drop `basic_auth` by state, and the bind policy
- `lib/caddy.js`: emit `basic_auth` only while the state is `account-required` or `fallback`; the
  `tailnetHost` / `remoteHttpCatchAll` guards become "requires a gate".
- Remove `/openclaw-direct/*` from `AUTH_BYPASS_PATHS` in the same change that stops emitting
  `basic_auth`. TangleClaw's gate-bypass list becomes TangleClaw-owned (ADR 0015: moved, not
  duplicated) — `isGateBypassPath` stops deriving from Caddy's list.
- `lib/caddy-drift.js` (#1394): an armed install's missing `basic_auth` is not divergence; a
  `account-required` install's missing `basic_auth` IS.
- `lib/bind-policy.js`: an armed TangleClaw gate satisfies "something guards the door", so caddy mode
  no longer has to refuse the opt-in on principle. **#1055**: name the stored `bindAllInterfaces`
  value in the locked hint and on the rollback path (option b, per the issue's own weighting).
- Re-check `docs/openclaw-setup.md`'s "Blank iframe" `curl` under the new carve-out.

**A-03 decisions (2026-09-13).**
- **Which states drop `basic_auth`: `armed` and `locked` — one predicate, `authGate.guardsTheDoor`.**
  Both are TangleClaw's gate enforcing with an account behind it. `account-required` keeps it
  (whoever reaches the first-account screen claims the install, so a remote site in front of it
  needs Caddy's gate), and so does `unreadable` (a state read that failed must never remove a gate).
  `open` never emits a gate the caller did not ask for. `fallback` is A-04's to add.
- **`gateState` is an OPTION of the generator, and omitting it keeps `basic_auth`.** The callers that
  decide the live ingress pass it (the cutover, the drift baseline). `lib/admin-credential.js`
  (reset-admin's gate creation and rotation) does not, so it behaves exactly as today; aligning it
  with the state machine is A-04's reset-admin work. Consequence carried to A-04: its round-trip check
  refuses an armed-generated file that has a tailnet or catch-all site.
- **The "requires a gate" guards** (`tailnetHost`, `remoteHttpCatchAll`, the LAN name) accept
  `basic_auth` or `guardsTheDoor(gateState)` — not `account-required`, for the claim reason above.
- **`header_up X-Auth-User` is no longer emitted** in any state: TangleClaw deletes the header on
  arrival, so the line was inert.
- **The bypass list is TangleClaw's** (`authGate.GATE_BYPASS_PATHS`: `/api/health`, `/manifest.json`),
  and Caddy's `basic_auth` matcher derives from it. `/openclaw-direct/*` leaves both. Carried to A-04:
  in `fallback`, Caddy's `basic_auth` is the only gate, and #472's prompt loop on `/openclaw-direct/*`
  comes back with it — decide there whether fallback accepts that or re-adds a Caddy-only exemption.
- **The cutover's refuse-to-ungate guard** refuses only when the new file carries no `basic_auth` AND
  TangleClaw's gate does not guard the door.
- **Drift:** P1 answers `holds` when the state guards the door (TangleClaw is the gate for every site
  that proxies to it; a site proxying anywhere else is P3's). A new P5 reads the LIVE file for
  `trusted_proxies` (server or `reverse_proxy` level) and any `header_up` op naming
  `X-Forwarded-For`, and reports either as divergence. `request_header` is not flagged: the proxy
  overwrites that value for an untrusted peer. Shapes taken from `caddy adapt` on v2.11.4.
- **Bind policy: caddy mode KEEPS pinning loopback.** ADR 0015's "a wide bind is guarded without a
  reverse proxy in front" is about DIRECT mode, and that is where it lands: a direct-mode wide bind
  (grace or opt-in) with the state guarding the door is no longer reported as "reachable with no
  password". Honouring a stored `bindAllInterfaces: true` in caddy mode was NOT built: every install
  that opted in before moving to caddy mode (#1055's population) would open a plain-HTTP listener on
  the LAN at its next restart after arming, from a choice nobody sees — the exact hazard #1055 is
  about — and Caddy already listens on every interface, so the side door buys nothing.
  **#1055 (option b):** the locked hint names the stored value from `bindState.choice` (already on
  the API) and says what it will do on leaving caddy mode; `ingress-cutover --to direct` prints the
  same (`describeDirectBind`).
- **`isProxyHeaderTrusted` keeps its condition (caddy ingress AND `authEnabled`), re-justified.**
  VERIFIED on Caddy v2.11.4 (throwaway instance, leased ports): `reverse_proxy` replaces a
  client-forged `X-Forwarded-Host` with the `Host` the client sent, and in caddy mode every remote
  request comes through Caddy. `authEnabled` stays because only then has the launching request passed
  a login. Dropping it was considered and not done: it would change a pinned behaviour for no reader.
- **Found and fixed in the gate: an exemption is honoured only when the router serves that path.**
  `//login` and `//manifest.json` are exempt to the canonicaliser but `new URL` routes them to `/`, so
  they served the dashboard shell with no session. `evaluate` requires `pathname` to equal the
  canonical path for all three exemptions.
- **Setup on an `unreadable` gate refuses to finish** (`503 GATE_UNREADABLE`, before the config save),
  so setup stays retryable instead of reporting `account.required: false`.
- **A-03 review (R-7): `authEnabled: false` does not open a caddy-mode install whose Caddyfile is an
  ungated remote door.** The file is written for the state at cutover time, the gate is read per
  request; `lib/caddy.js#describeIngressDoor` via `server.js#_gateIngress` keeps the accounts
  deciding while the file serves beyond `localhost` with no `basic_auth`. The cutover prints which
  gate it writes (`gateNote`).
- **Carried to A-04:** reset-admin passes `gateState` and the Caddyfile door like the cutover does;
  the bind notice and drift notice are computed once at boot (accepted — both re-evaluate on restart,
  and the gate itself is per request); close #1055 by hand when `train-9/cutover` reaches `main`.
  From the A-03 cumulative review (`rev-20260913T055830Z-267e3318`, 0 blocking):
  - R-6: `lib/admin-credential.js#canChangeCredential` / `#canCreateGate`, `deploy/INGRESS.md`
    "Creating a gate where there is none" and `public/ui.js`'s "The login is enforced by Caddy" still
    ask "is there `basic_auth`?". After an armed cutover, Settings > Login says there is nothing to
    change and `--create-gate` would put `basic_auth` back. Align them with `guardsTheDoor`.
  - R-1: #472's prompt loop on `/openclaw-direct/*` returns wherever `basic_auth` is written — the
    fallback, a cutover run before the first account, and reset-admin's gate creation. Decide once.
  - R-3/R-14: `caddy.describeIngressDoor` reads text and under-reports a top-level `import`, a
    brace-less site, and a `basic_auth` covering only some remote sites. Consider reading the door
    through `caddy adapt` (the drift module's rule) with a text fallback that fails closed.
  - R-8: `resolveGateState` without `loadIngress` opens; the generator without `gateState` keeps the
    gate. Every caller passes both today (pinned); reset-admin must too.
  - R-7: `isProxyHeaderTrusted` reads `authEnabled`, so the forwarded host is ignored on a caddy
    install enforcing with `authEnabled: false` (falls back to `Host`).
  - A-VRF, R-2: a pre-A-03 generated file still exempts `/openclaw-direct/.*`; with the login off,
    `//openclaw-direct/x` reaches the page shell (the API behind it stays gated).
- **`docs/openclaw-setup.md` curl:** still works from the machine itself (loopback, no browser
  headers, no cookie = the fleet carve-out); from anywhere else it now answers 401 without a session.

### A-04 — the kill-switch, recovery docs, and the drill

**Split into A-04a (recovery codes) and A-04b (the fallback, reset-admin, docs, drill), one review
each** — same reason as A-02: A-04a is a new pre-gate route, a store table and a Settings surface;
A-04b is the terminal side of recovery and the carried A-03 items. Neither depends on the other's code.

**A-04a:** recovery codes end to end (store, pre-gate redemption route + page, issuance on the
first-account screen, re-authenticated regeneration in Settings, the post-redemption dashboard
notice), plus the ADR 0009 rule 5 / security-model Direction amendment the ruling requires.
**A-04b:** the `fallback` state + command + marker, reset-admin aligned with the state machine (and
A-03's R-6/R-8), the #472 decision (R-1), the login page telling `locked`/`unreadable` apart, the
in-repo recovery doc + `SECURITY.md` login section + README link, and the drill script.

### Chunk A.04a (A-04a) — recovery codes

Delivers the "Recovery codes" and "ADR 0009 rule 5" bullets of the original A-04 list (kept verbatim
under A-04b's heading below, for the record).

**A-04a decisions (2026-09-13).**
- **Codes are per account, 8 of them, 25 Crockford base32 characters (125 bits)**, shown grouped in
  fives. Input is normalised (case, spaces, hyphens, `O`→`0`, `I`/`L`→`1`) before hashing, so a code
  read aloud or retyped from paper still works.
- **Stored as SHA-256, not scrypt.** A code is CSPRNG output with no dictionary to stretch against —
  the reason `auth-session#hashToken` is unsalted SHA-256 — and an indexed lookup by digest is what
  makes "wrong" and "already used" one query with one answer.
- **Redemption is atomic and ends every session.** The new password is hashed before the
  transaction; under `BEGIN IMMEDIATE` the code is re-checked unused, marked used, the password
  replaced and the account's sessions destroyed (the reset-admin reason: a reset that leaves the
  thief's session alive recovered nothing). Then the redeemer is signed in.
- **A code never re-enables a disabled account.** Codes for a disabled account answer exactly as a
  wrong code. `disable` is "revoke one person"; a revoked person's own codes must not undo it.
  So `locked` stays terminal-only — this narrows the A-02a note that said "terminal or recovery code".
- **Password policy runs after the code is known valid** (it needs the account's username). A weak
  password is then told apart from a wrong code only to someone already holding a valid code, and the
  code is not consumed.
- **Rate limit: failed redemptions per client**, where the client is the socket address, or Caddy's
  `X-Forwarded-For` when the request came through the proxy on loopback (Caddy replaces that value,
  verified in A-02a). A fixed window, bounded map. Only failures count. The entropy makes guessing
  hopeless regardless; the limit bounds log and CPU churn, and per-client (not global) so a flood
  cannot lock the operator out of their own recovery.
- **Exempt from the gate only in `armed`** — the one state a code can succeed in — and CSRF-exempt like
  login (its authority is the code in the body).
- **Regeneration requires the current password**, not just a session: a stolen session cookie that
  could mint codes would leave the thief a key that survives the operator's next password change.
- **The notice** is per account, shown in the dashboard to the account whose code was used, until that
  account acknowledges it or regenerates its codes. An explicit action, not a timer.
- Issued on the first-account screen. Accounts created by the wizard or `reset-admin.js` have none
  until regenerated in Settings (wizard issuance is #803).

**Carried to A-04b from the A-04a review (`rev-20260913T153542Z-387ef554`, 0 findings):**
- `store.users.enable` (reset-admin) leaves the account's old recovery codes in place, so re-enabling
  a disabled account at the terminal revives codes the revoked person may hold. Decide in the
  reset-admin rework: delete an account's codes on `disable` (as its sessions are), or on `enable`.
- The login page's "Use a recovery code" link also shows in `locked`/`unreadable`, where `/recover` is
  challenged back to the login page — lands with the login-page copy for those states.
- `.prawduct/artifacts/security-model.md` Direction was amended in the A-04a worktree copy only
  (gitignored); the primary checkout's copy needs the same paragraph.

### Security hotfix fold-in (2026-09-13) — before A.04b

Found during A.04b discovery: a Caddy `localhost` site with no gate answers other machines (Caddy
picks a site by Host, not by peer). Operator rulings, in the Builder pane: private advisory
GHSA-fhgg-4h57-q2f9; the peer-guard fix merged to `main` as PR #1451 with **no release** (it ships with
the sprint release); and the #1420 side lands here, on a sync branch that merges `main` into
`train-9/cutover`. Recorded in ADR 0016 "Recorded during #1420 — the peer guard". Decisions:
- The generator guards a site only when it has no gate of either kind (not in `armed`/`locked`).
- `describeIngressDoor` reports `unguardedLocalSite`; `resolveGateState` counts it against
  `authEnabled: false` only when accounts exist (ruled: no account stays open).
- The drift property for the guard is P6 here (P5 is `forwardedFor`), gate-aware; the fix script
  refuses when the login guards the door.
- **Writers resolve the gate from config, not the file they replace** (`authGate.resolveIntendedGateState`,
  Critic `rev-20260913T181335Z-09c75281` R-3): otherwise `authEnabled: false` could never take effect in
  caddy mode through any tool.
- **Carried to A.04b:** the fallback's "door observably present" check must require a gate on every
  site that proxies to TangleClaw, or the peer guard — never a site name.
- **Carried to A.04b from that review** (A.04b rewrites the login copy and touches these routes anyway):
  R-4 — the scrypt concurrency-cap code is copied into four routes (login, set-password, recover,
  recovery-codes) and the copies differ; one helper should own acquire/release. R-8 — the recovery
  routes answer the cap's 503 without the warn line login logs. R-6 — `lib/recovery-codes.js#clientKey`
  re-spells the proxy check `lib/auth-identity.js#cameThroughProxy` owns.

### Chunk A.04b (A-04b) — the fallback, reset-admin, recovery doc, drill

The original A-04 list; the recovery-code and ADR 0009 bullets are A-04a's.

- The fallback command (name decided in A-04): restore/regenerate the Caddyfile with the retained
  credential → validate → reload → probe 401 → only then write the `gate-fallback` marker; `--undo`
  in reverse order. TangleClaw honours the marker only while the fallback door is observably present.
- Recovery codes (the ruling): generate a small set of long random codes, show once, store hashed,
  single-use; a pre-gate redemption route + page that sets a new password under
  `caddy.validateAdminPassword` and signs in; rate-limited, and identical answers for a wrong code and
  an exhausted one; each redemption logged + a dashboard notice. Issued on the `account-required`
  set-password screen; a "regenerate recovery codes" action invalidates the old set. Wizard issuance
  for fresh installs is #803 (chunk 05).
- ADR 0009 rule 5 AND `.prawduct/artifacts/security-model.md` § Direction (the norm that binds it —
  "no second remote door"): amend both to match the ruling (off-box password reset by code holders only).
- `scripts/reset-admin.js`: aligned with the state machine (it recovers a forgotten password in
  `armed`; it must not silently leave `account-required`).
- An in-repo recovery doc (the parts of `~/.tangleclaw/EMERGENCY-RECOVERY.md` that describe the new
  door), linked from `README.md`.
- The drill script: break the gate on purpose, recover with the documented procedure, confirm the
  front door answers 401 then 200 with the fallback credential.

### A-VRF — before Checkpoint 2
- `/prawduct:critic` cumulative on `train-9/cutover`.
- elkaholic VRF per `reference_live_verification_traps` (the launchd `WorkingDirectory` and the
  service PATH), on a caddy-mode install carrying a bcrypt credential: migration, login, `basic_auth`
  drop, the `/openclaw-direct/*` iframe, the terminal socket, `tc` CLI + PortHub still working.
- The drills, both from the phone: a password recovered with a code, and a deliberately broken gate
  recovered over SSH.
- **Live-install cutover procedure** written for Checkpoint 2: merge → release → pull + restart →
  set password through the double gate → log in → operator-run `basic_auth` drop on the hand-edited
  Caddyfile (backup first) → verify → the memory `project_caddy_ingress_live_state` cleanup check.

## Out of this chunk
- #804, #803 (chunk 05). Retiring the fallback bcrypt credential (chunk 05 or later, operator's call).
- Tier 2 (ADR 0015 OQ5).

## Status
- [x] A-01 — ADR 0016 addendum + this plan
- [x] Checkpoint 1 — ruled 2026-09-13: 1 + 2
- [x] A-02a — classifier, gate on it, carve-out + XFF, set-password route/page (reviewed 2026-09-13, PR into `train-9/cutover`)
- [x] A-02b — OQ2 inversion, identity + authStatus from the classifier, dashboard consumers (reviewed 2026-09-13, PR into `train-9/cutover`)
- [x] Chunk A.03 (A-03) — state-driven `basic_auth`, bypass ownership, drift, bind policy, #1055 (reviewed 2026-09-13, PR into `train-9/cutover`)
- [x] Chunk A.04a (A-04a) — recovery codes end to end, ADR 0009 rule 5 + security-model Direction amendment (reviewed 2026-09-13, PR into `train-9/cutover`)
- [ ] Chunk A.04b (A-04b) — fallback state + command, reset-admin, #472 decision, login copy, recovery doc, drill
- [ ] A-VRF — cumulative Critic, elkaholic VRF, phone drill → Checkpoint 2
