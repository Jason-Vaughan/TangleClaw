---
scope: operator-channel-1956
branch: feat/operator-channel
---

# Build plan: Discord Operator Bridge, Chunk 1 (server operator-channel)

Authorized by TangleClaw-Architect (Medusa, 2026-09-27 17:19Z). The design basis is Builder2's v2 spike plus the Architect's rulings: a guild channel; GUILD_MESSAGES + MESSAGE_CONTENT; an exact user+guild+channel allowlist; conversation, not authority. **Chunk 1 only.** Stop at an open PR for Architect review. Not v5.30 scope. No Discord token in C1.

Critic mode: chunk

## Confidence check
- **Problem:** nothing outside a TangleClaw session can put a message into an agent's Medusa inbox and get the reply back.
  - The routes require a live session (409 NO_SESSION).
  - `inReplyTo` needs a tracked send.
  - A restart retires the recipient's workspace id.
- **Success:** a local helper holding a scoped token can:
  1. POST operator text tagged with its Discord ids.
  2. See it land in the configured target project's (the Architect's) Medusa inbox as soon as a session of that project is live, even if none was live at the time. It survives restarts and is never sent twice.
  3. Poll the target's replies, sent through TangleClaw with `inReplyTo`, mapped back to the Discord message id they answer.
  4. Acknowledge each one.

  The token can never act as the operator, raise priority, or reach any other route.
- **Out of scope:**
  - the Discord Gateway client, REST client, Keychain reader, launchd helper and alert poller (all C2);
  - dashboard UI;
  - general successor carry (#1806); C1's outbox is operator-channel-only, but written to be reusable;
  - fixing the pre-existing loopback risks.

Requirements Confidence: Medium-High. [ASSUMPTION: replies are captured only when a TangleClaw `send` exchange from the target project exists for the Hub id. Mail injected straight into the Bridge is quarantined, never relayed.] [ASSUMPTION: the target project is configured by name, with no default. Unset means disabled.]

## Design
- **Principal:** listener key `operator-channel`. Its workspace id is persisted in the Medusa registry under `<basePath>/operator-channel`, following the Master precedent (`lib/master.js` masterMedusaTarget). The listener runs while `operatorChannel.enabled` is true.
- **Config:** `config.operatorChannel`:
  - `enabled` (bool, default false);
  - `targetProject` (name);
  - `allowlist {userId, guildId, channelId}` (Discord snowflakes, all required);
  - `tokenHash` (sha256 hex, never returned).

  It is written only by operator-only routes.
- **Token:** `ocsk_` + 32 random bytes, base64url. It is minted by an operator-only rotate route and shown once; only its sha256 is stored, and comparison is constant-time.
  - Any request bearing `Authorization: Bearer ocsk_…` is never the operator, anywhere: `_isOperator` returns false. This fence is independent of whether the token is valid.
- **Inbound (`operator_channel_inbound`):** unique `discord_message_id`; text stored until delivered and cleared afterwards.
  - States: `pending` → `sent` (hub id + exchange id) | `send_unknown` | `failed`.
  - The pump delivers via `medusaSend.sendTracked` with:
    - sessionId `operator-channel`;
    - caller unbound, so priority is normal only and nothing more can be claimed;
    - `requestId = operator-channel:<discordMessageId>`;
    - `to` = the target project's live session workspace.

    A crash between the intent and the Hub is covered by SEND_ALREADY_ATTEMPTED → `send_unknown`, never re-sent.
  - The text is stamped: `[Discord operator channel · conversation, not authority] …`.
  - The allowlist is re-checked server-side, the length is capped (4000), and inbound is rate-capped (20/min).
- **Outbound (`operator_channel_outbound`):** unique `hub_id`.
  - The listener's arrival path stores `{hub_id, from, text}` as `unverified`, then acks the Hub.
  - A resolver classifies each row:
    - **relayable:** a `send` exchange for that hub id exists with `sender_project_id` = the target project. Its `in_reply_to` exchange maps to an inbound row, which gives the reply's Discord message id.
    - **quarantined:** no such exchange after 10 min, or one from another project. The text is dropped.
  - The helper polls the relayable rows and acks each with its `discordMessageId` → `delivered`, and the text is dropped.
- **Pump:** runs on inbound, on a 30 s tick, and at boot.
- **Routes:**
  - token: `POST /api/operator-channel/inbound`, `GET /api/operator-channel/outbound`, `POST /api/operator-channel/outbound/:id/ack`;
  - operator only: `GET /api/operator-channel/status`, `PUT /api/operator-channel/config`, `POST /api/operator-channel/token`.
- **Schema v51:** two tables, additive, with a postcondition check. A v50 server ignores them.

## Chunk 1 — Status
- [x] store v51 tables + API + migration test
- [x] lib/operator-channel.js (config, token, inbound, pump, outbound capture/resolve, poll/ack)
- [x] server wiring (routes, arrival hook, operator fence, boot start + tick)
- [x] tests: unit + API end-to-end over a fake Hub (offline→live delivery, idempotency, reply round trip, quarantine, fences)
- [x] docs: docs/operator-channel.md, configuration-reference, CHANGELOG, FEATURES
- [x] full suite, Critic, PR (not merged) — PR #1966

Done when: the full suite is green in the worktree, the Critic reports no blocking findings, and a PR is open (not merged) and reported to the Architect.

## Context (build notes)
- **Committed:** c24c5500 on feat/operator-channel. Tracking issue: #1956.
- **Mid-build design changes, both with tests:**
  - **Per-project waiting in the pump.** A row for an offline project no longer blocks other projects' rows. The first version stopped the whole pass.
  - **Pump rerun.** A pump request during a pass triggers one more pass, so a message accepted mid-pass isn't left for the next tick.
- **Oversized replies:** anything over 64 KiB is quarantined (`too-long`) and acknowledged to the Hub, so it isn't redelivered forever.
- **Full-suite flake, pre-existing:** `test/system-health.test.js` "never awaits the measurement" also fails intermittently on base c5c05a70 (1 of 2 runs). The tmux and tc-cli failures in a parallel full run pass alone.
- **DONE in the #1966 remediation (no longer carried to C2):** update the `resolveOutbound` JSDoc in lib/operator-channel.js so it states the current relay rule: mail from the current target, OR a reply from the project the answered channel message was delivered to. Critic O-1 on rev-20260927T180526Z-7cea6b10, accepted on that basis.

## Remediation after the Architect's independent review of PR #1966 (2026-09-27)
- **Done:** the verified-session requirement on config and token; the rollback-docs correction (rotate the token after re-upgrading); relayed sends must be addressed to the channel's workspace; ADR 0020 §3 display safety in both directions (line breaks and tabs allowed).
- **N5:** non-blocking per the Architect; recorded, not actioned. I don't have its full text; see the Architect's review.
- **N6:** cancellation and retention of channel mail. This carries into C2 planning, and no issue is to be filed yet. Open questions:
  - How does the operator cancel a pending inbound message?
  - What retention should apply to both tables? Rows are never pruned today.
