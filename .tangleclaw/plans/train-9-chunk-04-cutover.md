# Train 9 · Chunk 04 — the Tier 1 cutover (#1420), A-series build plan

**Issue:** #1420 (closes #1055). **Sprint:** v5.24, Lane A.
**Design of record:** ADR 0016, "Addendum (2026-09-13, Checkpoint 1)" and its "The ruling" section. Read both first.
**Integration branch:** `train-9/cutover`, cut from `origin/main` at or after `e471cae9`. Each A-chunk
is a feature branch merged INTO `train-9/cutover`, never into `main`. Only the final cumulative merge
reaches `main`, and only at Checkpoint 2.
**Builder:** the TangleClaw-Builder session itself. Never a subagent (sprint plan, Lane A).

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
  situation (no key yet), so it gets the same answer. The state is named `account-required`. Four states:
  `open` (`authEnabled` not exactly true), `account-required` (no user row), `armed` (an enabled
  account), `locked` (accounts exist, none enabled: closed, recovered by terminal or recovery code).
  An unreadable store or config is its own `unreadable` state, and it ENFORCES.
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


- `lib/auth-gate.js`: replace the dormancy predicate with the state classifier (see the A-02a
  decisions above); one owner, read by `evaluate` and `evaluateUpgrade`.
- The set-password screen and route for `migration-required`, applying `caddy.validateAdminPassword`,
  using the async scrypt path, retaining `basicAuthHash`.
- `isMachineClient` gains "no `X-Forwarded-For`". **First step: verify Caddy v2.11.4 sets and replaces
  the header**, against a generated and a hand-edited-shape Caddyfile on a PortHub-leased 5000+ port.
  If it does not, stop and re-open the carve-out decision; do not build on the recall.
- OQ2: delete inbound `X-Auth-User` at request entry with a warn; `lib/auth-identity.js` retargeted to
  the session ("forged header refused" replaces AUTH-3's "configured-no-identity");
  `activity_log` user from the session.
- Covers both transports and `server.js#peerReadTarget` (added by #918 behind the roster gate).
- Tests: every state × HTTP/upgrade × machine/browser/proxied; mutation-check each new guard.

### A-03 — Caddy's side: drop `basic_auth` by state, and the bind policy
- `lib/caddy.js`: emit `basic_auth` only while the state is `migration-required` or `fallback`; the
  `tailnetHost` / `remoteHttpCatchAll` guards become "requires a gate".
- Remove `/openclaw-direct/*` from `AUTH_BYPASS_PATHS` in the same change that stops emitting
  `basic_auth`. TangleClaw's gate-bypass list becomes TangleClaw-owned (ADR 0015: moved, not
  duplicated) — `isGateBypassPath` stops deriving from Caddy's list.
- `lib/caddy-drift.js` (#1394): an armed install's missing `basic_auth` is not divergence; a
  `migration-required` install's missing `basic_auth` IS.
- `lib/bind-policy.js`: an armed TangleClaw gate satisfies "something guards the door", so caddy mode
  no longer has to refuse the opt-in on principle. **#1055**: name the stored `bindAllInterfaces`
  value in the locked hint and on the rollback path (option b, per the issue's own weighting).
- Re-check `docs/openclaw-setup.md`'s "Blank iframe" `curl` under the new carve-out.

### A-04 — the kill-switch, recovery docs, and the drill
- The fallback command (name decided in A-04): restore/regenerate the Caddyfile with the retained
  credential → validate → reload → probe 401 → only then write the `gate-fallback` marker; `--undo`
  in reverse order. TangleClaw honours the marker only while the fallback door is observably present.
- Recovery codes (the ruling): generate a small set of long random codes, show once, store hashed,
  single-use; a pre-gate redemption route + page that sets a new password under
  `caddy.validateAdminPassword` and signs in; rate-limited, and identical answers for a wrong code and
  an exhausted one; each redemption logged + a dashboard notice. Issued on the `migration-required`
  set-password screen; a "regenerate recovery codes" action invalidates the old set. Wizard issuance
  for fresh installs is #803 (chunk 05).
- ADR 0009 rule 5 AND `.prawduct/artifacts/security-model.md` § Direction (the norm that binds it —
  "no second remote door"): amend both to match the ruling (off-box password reset by code holders only).
- `scripts/reset-admin.js`: aligned with the state machine (it recovers a forgotten password in
  `armed`; it must not silently leave `migration-required`).
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
- [ ] A-02a — classifier, gate on it, carve-out + XFF, set-password route/page
- [ ] A-02b — OQ2 inversion, identity + authStatus from the classifier, dashboard consumers
- [ ] A-03 — state-driven `basic_auth`, bypass ownership, drift, bind policy, #1055
- [ ] A-04 — fallback command, recovery codes, ADR 0009 rule 5 text, reset-admin, recovery doc, drills
- [ ] A-VRF — cumulative Critic, elkaholic VRF, phone drill → Checkpoint 2
