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
| `PUT /api/operator-channel/config` | Changes `enabled`, `targetProject` or `allowlist: {authorId, spaceId, channelId}`. The listener starts or stops to match. |
| `POST /api/operator-channel/token` | Mints a new helper token, shown once. |

Inbound refusals:

- `401`: no token, or the wrong one.
- `503 CHANNEL_DISABLED`: the channel is off.
- `403 NOT_ALLOWLISTED`: the author, space or channel isn't the allowlisted one, or no allowlist is set.
- `409 NO_TARGET`: no target project is set.
- `400`: a malformed message.
- `413`: the text is over 4000 characters.
- `429`: more than 20 new messages in a minute. A replay of an accepted id is always answered.

## Delivery

A delivery pump runs when a message is accepted, every 30 seconds, and at boot. It works through waiting messages in order:

- **When a target session is live,** each message is sent through the ordinary tracked Medusa send, so it is an exchange like any other (`docs/medusa-delivery.md`).
- **When the target has no live session,** its messages wait, in order. Messages for other projects still go.
- **When the Hub's answer is lost,** the message becomes `send_unknown` and is **never sent again**. This includes a crash between recording the send and hearing back: the retry reuses the request id, and the exchange record's duplicate guard catches it.
- **When the Hub refuses a send,** it is retried under a fresh request id, up to five attempts, then `failed`. A refusal means the message is known not to be on the Hub.

A message's text is dropped once it is `sent` or `send_unknown`.

## Replies

The target project replies through its own switchboard route, sending to the channel's workspace id with `inReplyTo` set to the message it answers. That works because the channel's message was a tracked send addressed to the project. The reply comes back to the helper with the chat message id it answers. A message sent without `inReplyTo` comes back as a reply to nothing.

**Only mail TangleClaw recorded as a send from the target project is ever handed to the helper.** The Medusa Bridge accepts any local caller's `from`, so everything else is quarantined and its text dropped:

- mail sent by another project is quarantined at once;
- mail that no TangleClaw send made is quarantined after ten minutes;
- a message longer than 64 KiB, which no switchboard route accepts, is kept only as a quarantined record.

## Storage

- `operator_channel_inbound`: one row per message, unique by the helper's message id. States: `pending`, `sent`, `send_unknown`, `failed`.
- `operator_channel_outbound`: one row per received message, unique by Hub id. States: `unverified`, `relayable`, `delivered`, `quarantined`.

Text is kept only until it is handed on. Nothing prunes the rows yet.

## Setting it up

1. Create the helper's chat identity and note the author, space and channel ids to allowlist.
2. `PUT /api/operator-channel/config` with `enabled: true`, the target project's name and the allowlist.
3. `POST /api/operator-channel/token`, and give the token to the helper. Keep it in the macOS Keychain: never in a repository, a config file, a log or a command line.
4. `GET /api/operator-channel/status` should show the listener `listening`.

Every message and reply passes through the chat provider, so turning the channel on sends content off this machine. That is the operator's decision to make.
