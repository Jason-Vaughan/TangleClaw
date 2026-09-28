# Discord helper

Status: experimental. Issue #1799.

The Discord helper lets the operator talk to one TangleClaw project from Discord, and hear from TangleClaw when it needs attention, away from the workstation. It is a small local process, `bin/tc-discord-helper`, run by launchd. It sits between Discord and TangleClaw's [operator channel](operator-channel.md):

- **Discord to TangleClaw:** it listens to one Discord channel over the Gateway, and hands the allowlisted operator's messages to the channel.
- **TangleClaw to Discord:** it collects the project's replies and TangleClaw's notifications and posts them in that channel.

It talks to Discord over Discord's API and Gateway only. The Discord desktop app is not needed on the TangleClaw host.

## What it will and will not do

- **Conversation, never authority.** A Discord message is delivered to the project stamped as conversation. It cannot approve a merge, a release, a deletion or any other privileged action, whatever it says, and the helper attaches no meaning to it.
- **One operator, one server, one channel.** Messages from anyone else, from another server or channel, from a bot (itself included) or from a webhook are ignored. They are ignored by their ids, before their text is read, so nothing of theirs reaches TangleClaw, a log or a reply.
- **Only the channel's three routes.** The helper holds the channel's `ocsk_` token, which TangleClaw refuses on every other route. It has no dashboard session and no service token.
- **Text only.** Attachments, voice and slash commands are not relayed.
- **Messages sent while the helper is down are not caught up.** The Gateway does not replay them. Send those messages again once `status` shows the Gateway `ready`. Replies and notifications are different: they wait on TangleClaw's side, so nothing is lost while the helper or Discord is down.

## Setting it up

You need the TangleClaw side first: [operator-channel.md](operator-channel.md) "Setting it up" (an armed login gate, the channel enabled with its target project and allowlist, and a minted token).

### 1. The Discord application

In the Discord Developer Portal, for the existing application:

1. **Bot → Privileged Gateway Intents: turn on Message Content Intent.** Without it Discord refuses the connection (close code 4014), and `status` says so.
2. **Bot → Reset Token**, and keep the token for step 3. It is shown once.
3. **Invite the bot** to the server with these permissions in the operator's channel: View Channel, Send Messages, Read Message History and Add Reactions.
4. **In Discord, User Settings → Advanced → Developer Mode.** Then right-click to copy three ids: your own user id, the server id and the channel id. These are the ids the TangleClaw allowlist holds.

### 2. The helper's config

```sh
bin/tc-discord-helper configure --base-url http://127.0.0.1:3102 \
  --author <your user id> --guild <server id> --channel <channel id>
```

This writes `~/.tangleclaw/discord-helper.json` (owner-only). It holds no secret. `--poll-seconds` (5-300, default 15) sets how often replies are collected.

### 3. The two secrets, in the Keychain

```sh
bin/tc-discord-helper set-secret bot       # paste the Discord bot token
bin/tc-discord-helper set-secret channel   # paste the ocsk_ channel token
```

Each command reads the token with echo off, stores it in your login Keychain (service `tangleclaw-discord-helper`), and reads it back to confirm it was stored. The token travels to `security` on its standard input, so it is never in a command line (visible to `ps`), an environment variable, a file or a log. A token is letters, digits, `.`, `_` and `-`; anything else is refused. Never put either token in a repository, the config, the launchd job or a shell command.

### 4. Check it

```sh
bin/tc-discord-helper verify
```

This proves the channel token against TangleClaw and the bot token against Discord, and posts one test notification in the channel. It acknowledges nothing.

### 5. Run it under launchd

```sh
bin/tc-discord-helper install-launchd
```

This writes `~/Library/LaunchAgents/com.tangleclaw.discord-helper.plist` from `deploy/com.tangleclaw.discord-helper.plist` and loads it. The job carries paths and a label only. launchd starts the helper at login and restarts it if it exits, at most once every 30 seconds. Use `--no-load` to write the job without loading it.

Then do a round trip: write in the channel. Expect a ✅ reaction once TangleClaw has the message, then the project's reply.

## Operating it

- **`bin/tc-discord-helper status`** shows the config, whether each secret is present (never its value), whether the helper is running, the Gateway's state, the last poll of TangleClaw, and any reply held for you. It never shows a secret or a message's text.
- **The log** is `~/.tangleclaw/logs/discord-helper.log`. It holds one JSON line per event: a timestamp, a closed code, and ids or numbers. It never holds message text, tokens, headers or Discord's raw responses.
- **Stopping:** `launchctl bootout gui/$(id -u)/com.tangleclaw.discord-helper`. **Removing:** `bin/tc-discord-helper uninstall-launchd`, which keeps the Keychain items and `~/.tangleclaw/discord-helper/`. To remove the secrets too, run `security delete-generic-password -s tangleclaw-discord-helper -a discord-bot-token` (and `-a operator-channel-token`).
- **Only one helper runs.** A second one refuses to start, because two would post every reply twice.

## How a reply is delivered, and when it is held

A reply or notification is acknowledged to TangleClaw only after Discord has posted it and returned the message's id. Before each post, the helper records what it is about to do in `~/.tangleclaw/discord-helper/state.json`. Each post carries a nonce Discord uses to refuse a repeat. Together these make a crash or a lost answer safe:

- **Discord or the network is down:** nothing is acknowledged. The reply waits on TangleClaw and is posted once Discord answers again. Polling backs off to at most once every 5 minutes.
- **The helper restarts after posting but before acknowledging:** it acknowledges the same reply, and posts nothing again.
- **A post's outcome is unknown** (a timeout, or a crash mid-post): the helper retries with the same nonce for up to 2 minutes, and Discord returns the message it already made rather than a second one.
- **Past that, a retry could duplicate the reply,** so the reply is held as `uncertain`. It is never reposted or acknowledged by itself. `status` lists it.
- **Discord rejects a reply's content** (HTTP 400): the reply is held as `rejected`, and the replies after it keep moving.

To settle a held reply, stop the helper, look in the channel, then run one of:

```sh
bin/tc-discord-helper settle <id> --posted <discord message id>   # it did post: acknowledge it with that id
bin/tc-discord-helper settle <id> --repost                         # it did not: post it on the next run
```

Then start the helper again. A reply longer than Discord's 2000 characters is posted as up to 5 messages, in order. Anything past that is cut, with a note saying how many characters were left out.

## Refusals the operator sees

When TangleClaw refuses a message, the helper replies to it in fixed words and adds no ✅. The limits are TangleClaw's (see [operator-channel.md](operator-channel.md)):

| Reply starts "Not delivered:" and says | Why |
|---|---|
| the operator channel is turned off | the channel is disabled |
| TangleClaw does not allow this author, server or channel | the ids do not match TangleClaw's allowlist |
| no target project is set | the channel has no target project |
| the text is not display-safe | control or invisible characters, or emoji written with a variation selector or joiner (a red heart, a skin tone) |
| over 4000 characters | the length limit |
| more than 20 messages in a minute | the rate limit |
| TangleClaw refused the helper's token | the token was re-minted; run `set-secret channel` with the new one |
| TangleClaw could not be reached | three attempts failed; send it again later |

## Troubleshooting by log code

| Code | Meaning and what to do |
|---|---|
| `config-missing`, `config-invalid` | Run `configure`. |
| `secret-missing`, `secret-read-failed` | Run `set-secret` for the named secret. `secret-read-failed` can also mean the login Keychain is locked. |
| `state-unreadable` | `~/.tangleclaw/discord-helper/state.json` is damaged. The helper will not start without it, because forgetting a reply in flight could post it twice. Look at it, and move it aside only once you have checked the channel for the replies it names. |
| `helper-already-running` | Another helper is running. |
| `gateway-fatal` | Discord refused the connection for a reason a retry cannot fix. The close code is in the log and in `status`: 4004 is a bad bot token (run `set-secret bot`), and 4014 means Message Content Intent is off (step 1). The helper keeps posting replies, but reads nothing until it is restarted. |
| `outbound-uncertain`, `outbound-rejected` | A reply is held; see "When it is held". |
| `outbound-poll-failed`, `inbound-transport-failed` | TangleClaw could not be reached. |
| `outbound-post-failed` | Discord refused a post or could not be reached; it is retried with backoff. |
| `discord-rate-limited` | Discord asked the helper to wait (at most 30 seconds are honoured); the call is retried once, then counts as a failure. |
| `outbound-queue-held` | Every reply TangleClaw listed is held for you, and newer ones may be queued behind them. Settle the held replies (`status` lists them). |

The full code list is in `lib/discord-helper/log.js`.

## Verification on the operator's Mac

The automated tests cover every rule on this page against fakes and the real channel routes (`test/discord-helper*.test.js`). These checks need the operator's own Mac and Discord account:

- the Keychain items, the launchd install, restart and backoff;
- a live `operator-needed` notification;
- one two-way conversation;
- the Discord desktop app being absent.
