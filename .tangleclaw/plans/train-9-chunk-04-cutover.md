# Train 9 · Chunk 04 — the Tier 1 cutover (#1420), A-series build plan

**Issue:** #1420 (closes #1055). **Sprint:** v5.24, Lane A.
**Design of record:** ADR 0016, "Addendum (proposed 2026-09-13, Checkpoint 1)". Read it first.
**Integration branch:** `train-9/cutover`, cut from `origin/main` at or after `e471cae9`. Each A-chunk
is a feature branch merged INTO `train-9/cutover`, never into `main`. Only the final cumulative merge
reaches `main`, and only at Checkpoint 2.
**Builder:** the TangleClaw-Builder session itself. Never a subagent (sprint plan, Lane A).

## Gates

- **Checkpoint 1 (after A-01):** the operator picks the kill-switch reach (ADR 0016 addendum,
  Options 1–3). **Nothing below A-01 is built until that ruling is recorded** on #1420 and in the ADR.
  A-02 does not depend on which option is picked, but it is still held: a ruling can reshape the
  state machine (Option 2 adds a pre-gate route), and the sprint plan says nothing past A-01.
- **Checkpoint 2 (after A-04):** cumulative Critic clean, elkaholic VRF PASS, kill-switch drill PASS
  **from the operator's phone**, and the operator says "merge". A relayed or inferred go is not one.

## Chunks

### A-01 — discovery + design (this document)
- ADR 0016 addendum: the kill-switch options, the migration state machine, state-driven `basic_auth`,
  and the `isMachineClient` revisit.
- This plan. → **Checkpoint 1.**

### A-02 — the state machine and TangleClaw's side of the door
- `lib/auth-gate.js`: replace the dormancy predicate with the four-state classifier (`open` /
  `migration-required` / `armed` / `fallback`); one owner, read by `evaluate` and `evaluateUpgrade`.
  The fallback state is recognised but not yet reachable (A-04 adds the command).
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
- The reach, per the Checkpoint 1 ruling (Option 1: documentation and a phone drill; Option 2: the
  pre-gate route plus code issue/re-issue; Option 3: the probation timer).
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
- The kill-switch drill, from the phone.
- **Live-install cutover procedure** written for Checkpoint 2: merge → release → pull + restart →
  set password through the double gate → log in → operator-run `basic_auth` drop on the hand-edited
  Caddyfile (backup first) → verify → the memory `project_caddy_ingress_live_state` cleanup check.

## Out of this chunk
- #804, #803 (chunk 05). Retiring the fallback bcrypt credential (chunk 05 or later, operator's call).
- Tier 2 (ADR 0015 OQ5).

## Status
- [x] A-01 — ADR 0016 addendum + this plan
- [ ] Checkpoint 1 — kill-switch reach ruled
- [ ] A-02 — state machine, set-password, carve-out, OQ2
- [ ] A-03 — state-driven `basic_auth`, bypass ownership, drift, bind policy, #1055
- [ ] A-04 — fallback command, reach, reset-admin, recovery doc, drill
- [ ] A-VRF — cumulative Critic, elkaholic VRF, phone drill → Checkpoint 2
