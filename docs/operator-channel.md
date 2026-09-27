# Operator channel

Status: experimental. Schema v51.

The operator channel lets a local chat helper, such as the Discord bridge, talk to one TangleClaw project on the operator's behalf:

- the operator writes in a chat;
- the helper hands the message to TangleClaw;
- TangleClaw delivers it to that project's live session over Medusa;
- the project's replies come back to the helper, which posts them in the chat.

Messages are kept durably in both directions. A message written while the project is offline, or between two of its sessions, is delivered when a session is next live. No message is delivered twice.

This page covers TangleClaw's side. The helper itself (the Discord Gateway client, where its token is kept, and the launchd job) is documented with the helper.

## What the channel is, and is not

- **A Medusa participant that is not a session.** It has its own stable workspace id, kept in the Medusa registry under `~/.tangleclaw/operator-channel`, so the target project always answers the same address. Its listener runs while the channel is enabled. It has no pane and is never woken.
- **Conversation, never authority.** Every message it delivers:
  - is sent as `normal` priority by an unbound caller, so it cannot claim `blocking` or `critical`, and cannot reply to or close an exchange;
  - starts with `[Operator channel · conversation, not authority]`.

  An agent must not treat such a message as approval to merge, release, delete or change anything that needs the operator.
- **One target project.** The operator names it. Messages are delivered only to that project's active session. Each message remembers the project it was accepted for, so changing the target later does not redirect messages still waiting.
- **One allowlisted author, space and channel.** For Discord these are the user, guild and channel ids. TangleClaw checks them on every message, in addition to the helper's own check.
- **Chat-agnostic.** TangleClaw speaks of an author, a space and a channel, and knows nothing of Discord.

## The token

- **Minting:** the operator mints the helper's token with `POST /api/operator-channel/token`. It starts with `ocsk_`, is shown once, and only its SHA-256 is stored. Minting again revokes the previous token at once.
- **A signed-in session is required.** Minting the token and changing the settings need an operator signed in to TangleClaw's own login. The dashboard's headers on an open gate are not enough, because any local process can send them. On an install whose gate is open or in fallback behind Caddy, these two routes refuse everyone (`403 OPERATOR_VERIFICATION_REQUIRED`), so the channel cannot be set up until the gate is armed. Reading the status needs only what any operator read needs.
- **Scope:** the token is good for exactly three routes, listed below. **A request carrying an `ocsk_` token is refused on every other route** with `403 CHANNEL_TOKEN_SCOPE`, even if it also carries dashboard headers or a signed-in session. The helper relays a third-party chat, so nothing it sends may be read as the operator.

## Routes

The helper calls these with `Authorization: Bearer <token>`:

| Route | Does |
|---|---|
| `POST /api/operator-channel/inbound` | Hands over one message: `{message: {id, authorId, spaceId, channelId}, text}`. Returns `202` for a new message and `200` for an id already accepted, which changes nothing. Delivery is asynchronous. |
| `GET /api/operator-channel/outbound` | The replies waiting to be posted: `{replies: [{id, text, inReplyTo: {messageId} or null, receivedAt}]}`. |
| `POST /api/operator-channel/outbound/:id/ack` | The helper posted a reply: `{postedId}`. Its text is then dropped. A second ack is answered from the record. |

Only the operator may call these. An agent session, a local script, and a request carrying a channel token are refused:

| Route | Does |
|---|---|
| `GET /api/operator-channel/status` | Settings (never the token or its hash), the listener, and message counts per state. |
| `PUT /api/operator-channel/config` | Signed-in operator only. Changes `enabled`, `targetProject` or `allowlist: {authorId, spaceId, channelId}`. The listener starts or stops to match. |
| `POST /api/operator-channel/token` | Signed-in operator only. Mints a new helper token, shown once. |

Inbound refusals:

- `401`: no token, or the wrong one.
- `503 CHANNEL_DISABLED`: the channel is off.
- `403 NOT_ALLOWLISTED`: the author, space or channel isn't the allowlisted one, or no allowlist is set.
- `409 NO_TARGET`: no target project is set.
- `400`: a malformed message, or `UNSAFE_TEXT` for text that is not display-safe (see below).
- `413`: the text is over 4000 characters.
- `429`: more than 20 new messages in a minute. A replay of an accepted id is always answered.

## Display safety

Chat text is checked in both directions against the display-safety rule of ADR 0020 §3 (Architect rulings A29 and A30, `workload.isSafeText`). The one difference: line breaks and tabs are allowed, because a chat message is many lines where a workload field is one.

The rule refuses:
- every other control character (a carriage return included);
- bidi controls and zero-width characters;
- U+2028 and U+2029;
- default-ignorable characters such as variation selectors;
- text with no visible character.

So neither the agent nor the operator ever reads text that displays differently from what was sent.

- **Inbound:** refused with `400 UNSAFE_TEXT`.
- **Outbound:** a reply that is not display-safe is quarantined (`unsafe-text`) and never relayed.

As in ADR 0020, this is display integrity only. It is not Unicode normalization, and it does not detect look-alike characters.

**Emoji.** Many common emoji are written with a variation selector (U+FE0F) or a zero-width joiner (U+200D), for example ❤️, or 👍🏽 with a skin tone. The rule refuses those, as it does in workload text. An operator message containing one is refused, and a reply containing one is quarantined. Single-code-point emoji and symbols are accepted.

## Delivery

A delivery pump runs when a message is accepted, every 30 seconds, and at boot. It works through waiting messages in order:

- **When a target session is live,** each message is sent through the ordinary tracked Medusa send, so it is an exchange like any other (`docs/medusa-delivery.md`).
- **When the target has no live session,** its messages wait, in order. Messages for other projects still go.
- **When the Hub's answer is lost,** the message becomes `send_unknown` and is **never sent again**. This includes a crash between recording the send and hearing back: the retry reuses the request id, and the exchange record's duplicate guard catches it.
- **When the Hub refuses a send,** it is retried under a fresh request id, up to five attempts, then `failed`. A refusal means the message is known not to be on the Hub.

A message's text is dropped once it is `sent` or `send_unknown`.

## Replies

The target project replies through its own switchboard route, sending to the channel's workspace id with `inReplyTo` set to the message it answers. That works because the channel's message was a tracked send addressed to the project. The reply comes back to the helper with the chat message id it answers. A message sent without `inReplyTo` comes back as a reply to nothing.

**Only mail TangleClaw recorded as a send addressed to the channel's own workspace, from the target project or as a reply from the project a channel message was delivered to, is ever handed to the helper.** A message accepted before the operator changed the target still goes to its original project, so that project's answer still comes back. The Medusa Bridge accepts any local caller's `from`, so everything else is quarantined and its text dropped:

- mail sent by another project, or a send its sender addressed to another workspace, is quarantined at once;
- mail that no TangleClaw send made is quarantined after ten minutes;
- a message longer than 64 KiB, which no switchboard route accepts, is kept only as a quarantined record.

## Storage

- `operator_channel_inbound`: one row per message, unique by the helper's message id. States: `pending`, `sent`, `send_unknown`, `failed`.
- `operator_channel_outbound`: one row per received message, unique by Hub id. States: `unverified`, `relayable`, `delivered`, `quarantined`.

Text is kept only until it is handed on. Nothing prunes the rows yet.

## Rolling back

Schema v51 is purely additive. A v50 server:
- ignores the two channel tables;
- runs no listener and no pump, so nothing is sent or relayed while rolled back;
- **does not know the `operatorChannel` config key, so its `GET /api/config` returns `operatorChannel.tokenHash` unredacted.** The hash cannot be used as the token, but no route is meant to return it.

**Rotate the token after re-upgrading** (`POST /api/operator-channel/token`), and give the helper the new one. The stored hash of a token that was visible while rolled back then names nothing.

Nothing else is lost. After a re-upgrade, waiting messages are delivered and replies the Hub queued meanwhile are collected. To stop the channel without rolling back, turn it off with `PUT /api/operator-channel/config {"enabled": false}`.

## Setting it up

1. Create the helper's chat identity and note the author, space and channel ids to allowlist.
2. Sign in to TangleClaw (the gate must be armed), then `PUT /api/operator-channel/config` with `enabled: true`, the target project's name and the allowlist.
3. `POST /api/operator-channel/token`, and give the token to the helper. Keep it in the macOS Keychain: never in a repository, a config file, a log or a command line.
4. `GET /api/operator-channel/status` should show the listener `listening`.

Every message and reply passes through the chat provider, so turning the channel on sends content off this machine. That is the operator's decision to make.
