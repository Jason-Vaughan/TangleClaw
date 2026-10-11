# The operator bridge's Discord helper

The helper is a small local process, `bin/tc-bridge-helper`, that sits between Discord and the
[operator bridge](operator-bridge.md). It is the only thing that talks to Discord.

- **Discord to TangleClaw:** it listens to one Discord channel over the Gateway and hands the
  allowlisted operator's messages to the bridge.
- **TangleClaw to Discord:** it claims what the bridge has released for the operator, posts it
  in that channel, and acknowledges each item once Discord confirms the post.

It talks to TangleClaw through the bridge's six helper routes and nothing else, on this
machine only: the bridge refuses the helper's token from anywhere else. No session
has a path to Discord: an answer reaches the helper only after the Project Master releases it.

## Status

Built and tested against the real bridge routes and a stand-in for Discord. **It has not been
run against Discord.** The bridge is disabled by default and Rule #145's interim procedure
([discord-operator-notifications.md](discord-operator-notifications.md)) is still the only
Discord path in force. Installing the helper is part of cutover, which needs the security
review, a live round trip and the operator's approval. Do not set it up on a live install
because this page exists.

## What it will and will not do

- **Conversation, never authority.** A Discord message is handed over as conversation. It
  cannot approve a merge, a release, a deletion or any other privileged action, whatever it
  says, and the helper attaches no meaning to it.
- **One operator, one server, one channel, checked twice.** The helper ignores a message from
  anyone else, another server or channel, a bot (itself included) or a webhook. It decides on
  ids alone, before reading the text, and logs nothing for it, so nothing of theirs reaches
  TangleClaw, a log or a reply. The bridge then checks the same three ids against the operator's own allowlist. Both
  must agree.
- **One channel out.** The helper posts to its configured channel only. An item naming another
  channel is not posted.
- **Text only.** Attachments, voice and slash commands are not relayed.
- **No pings.** Relayed text cannot mention anyone.
- **No redirects.** Neither the bridge client nor the Discord client follows a redirect, so
  neither token is ever sent to a host other than the one configured.
- **A reaction means TangleClaw has the message, not that anyone read it.** The helper adds ✅
  once the bridge has stored the message. What happens next is in
  [operator-bridge.md](operator-bridge.md).
- **The bot shows as online while the helper is connected.** The helper identifies to Discord as
  online, so the bot appears as an online member of the server while the helper holds its
  Gateway connection, and as offline within a minute or so of the helper stopping. It is the
  one Discord identity the bridge has: the bot, not a user account. **Online proves one thing:
  the helper's Gateway connection.** That the bridge is operational takes three things
  together: the bridge enabled (`GET /api/bridge/operator/status`), a verified Master
  (`tc bridge status` answers with its generation), and the Gateway `ready`
  (the helper's `status` command). The helper connects whenever it runs, and launchd starts it
  at every login, so the bot can be online while the bridge is disabled. `tc bridge status`
  answers in the Project Master's pane only.
- **Messages sent while the helper is down are not caught up.** The Gateway does not replay
  them. Send them again once `status` shows the Gateway `ready`; `status` shows what the helper
  last wrote down, once a pass, so allow it up to a poll interval to catch up. Answers and notifications are
  different: they wait at the bridge, so none is lost while the helper or Discord is down.

## Setting it up

The bridge comes first: the operator sets its allowlist and creates the helper token, signed in
with an account session ([operator-bridge.md](operator-bridge.md), "The operator's routes").

### 1. The Discord application

In the Discord Developer Portal, for the application:

1. **Bot → Privileged Gateway Intents: turn on Message Content Intent.** Without it Discord
   refuses the connection (close code 4014), and `status` says so.
2. **Leave the bot's token as it is.** The install already keeps it in the Keychain (step 3), and
   the interim procedure posts with that same item. Resetting the token in the portal
   invalidates it for both. Reset it only if the Keychain holds no such item, and then store the
   new one as step 3 says.
3. **Invite the bot** to the server with these permissions in the operator's channel: View
   Channel, Send Messages, Read Message History and Add Reactions.
4. **In Discord, User Settings → Advanced → Developer Mode.** Then right-click to copy three
   ids: your own user id, the server id and the channel id. They are the same three the
   bridge's allowlist holds.

### Which helper you are running

Run the helper by its whole path, under the checkout the TangleClaw service runs from, and never
as `bin/tc-bridge-helper` from wherever the terminal happens to be. `install-launchd` writes the
location of the script it was run as into the launchd job, so a helper started from another
worktree installs a job that runs that worktree's code, with both secrets, from then on.

Set `TC_CHECKOUT` to the service's checkout once. Every command below refuses to run without it.
During a cutover, use the `tc_helper` command of
[the activation runbook](runbooks/activate-the-operator-bridge.md#checked-commands) instead: it
also proves the checkout is the one the server's job names and is at the recorded commit.

### 2. The helper's config

```sh
"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" configure --base-url 'http://127.0.0.1:3102' \
  --author <your user id> --guild <server id> --channel <channel id>
```

This writes `~/.tangleclaw/bridge-helper/config.json`, owner-only. It holds no secret, and it
is outside the repository, so no Discord id is in a tracked file.

- `--base-url` is where TangleClaw answers, and must name this machine (`127.0.0.1`,
  `localhost` or `[::1]`), over `http://` or `https://`. Keep it in quotes: unquoted, a shell
  reads the brackets of `http://[::1]:3102` as a file pattern and runs nothing. The bridge answers the helper only for
  a request made directly from this machine, so there is nowhere else to send the token. It
  may carry no user name or password.
- `--poll-seconds` (5 to 300, default 15) sets how often the helper asks what to post.
- A value that does not pass is refused, the field is named, and nothing is written.

### 3. The two secrets, in the Keychain

```sh
"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" set-secret helper
```

The helper token comes from the dashboard: global settings, **Operator bridge (Discord)**,
**Create the helper token**. It is shown once. Run the command above, press **Copy** in the
panel, paste at the prompt, then press **I have stored it**. It is never written to a file or
given on a command line.

The helper reads two Keychain items. The **Discord bot token** is the item this install
already keeps it in (service `tangleclaw-discord-helper`, account `discord-bot-token`): the
helper uses it where it is, so there is nothing to copy. Run `set-secret bot` only if the bot
token itself has changed. The **helper token** is the helper's own (service
`tangleclaw-bridge-helper`, account `bridge-helper-token`).

`set-secret` reads the token from standard input, with echo off at a terminal, stores it in
your login Keychain and reads it back to confirm. The token
travels to `security` on its standard input, so it is never in a command line (visible to
`ps`), an environment variable, a file or a log. A value that is not the shape of its token is
refused before anything runs. Never put either token in a repository, the config, the launchd
job or a shell command. `set-secret` takes no token as an argument.

### 4. Check it, without posting anything

```sh
"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" preflight
```

Preflight proves everything it can without posting, claiming or changing anything. One line a
check: `ok`, `FAIL` with a closed word, or `unproven`.

| Check | Proves |
|---|---|
| `config`, `secret-bot`, `secret-helper` | The config passes; both Keychain items are present and shaped like their tokens. |
| `state-file` | The record of posts, if there is one, is readable and owner-only, in an owner-only directory. |
| `lock-free` | No helper is running. |
| `bridge-token`, `bridge-allowlist`, `bridge-circuit` | The bridge takes the helper token; the three configured ids are the allowlisted ones; the configuration circuit is closed. |
| `bridge-enabled` | `unproven` until the operator enables the bridge, which comes after preflight. |
| `discord-token`, `discord-channel` | Discord takes the bot token as a bot's; the channel is visible to it and is in the configured server. |
| `discord-post` | Always `unproven`: whether the bot may post there cannot be read without posting. The first controlled message proves it. |

It exits non-zero if any check fails. It prints no secret and no id.

### 5. Run it under launchd

On a live install, do this only where [the activation runbook](runbooks/activate-the-operator-bridge.md)
says to: after the operator has enabled the bridge. A helper started against a disabled bridge
finds every claim refused, backs off to five minutes, and answers each operator message with
"Not delivered: the TangleClaw operator bridge is turned off."

```sh
"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" install-launchd
```

This writes `~/Library/LaunchAgents/com.tangleclaw.bridge-helper.plist` from
`deploy/com.tangleclaw.bridge-helper.plist` and loads it. The job carries paths and a label
only. launchd starts the helper at login and restarts it if it exits, at most once every 30
seconds. `--no-load` writes the job without loading it.

## Where it connects

The helper connects to Discord's Gateway at the address Discord gives it, and resumes a dropped
session at the address Discord named when the session began. Both connections carry the bot
token, so both addresses are held to one fixed rule first: `wss`, no user or password, no port
but 443, and a host that is `gateway.discord.gg` or a subdomain of `discord.gg`. Anything else
is never opened.

- A refused first-connection address: the log records `gateway-address-refused`, and the helper
  identifies at the default address, `gateway.discord.gg`.
- A refused resume address: the session is dropped, the log records `gateway-resume-refused`,
  and the helper identifies afresh at the default address.

### When a connection attempt goes nowhere

A connection can fail without ever closing, and the helper does not wait for a close to try
again. Three things end an attempt, and each is followed by another attempt on the same backoff
as any reconnect (about a second at first, doubling to a ceiling of one minute, and back to the
start once a session is ready):

- **It fails before it opens** (the connection is refused, the host name does not resolve, the
  network is down). The log records `gateway-connect-failed`. Node's WebSocket reports these
  with an error and no close, so the helper retries from the error.
- **It takes longer than 30 seconds** from the start of the attempt to a ready or resumed
  session. The log records `gateway-attempt-abandoned` with how far it got: `lookup` (Discord
  had not yet said where to connect), `socket` (a connection was started and never opened),
  `open` (it opened and Discord said nothing), or `hello` (Discord greeted the helper and the
  session never became ready). The connection is closed in the way that keeps the session, so
  the next attempt resumes it and no message is missed that Discord still holds.
- **Nothing is happening at all.** Once a minute a watchdog checks for a helper with no
  connection, no attempt in flight and no reconnect waiting, and starts an attempt. The log
  records `gateway-watchdog-reconnect`. No way to reach that state is known; a line with this
  code is a defect to report, with the lines before it.

Posting does not depend on any of this: the helper posts over Discord's REST API whether or
not the Gateway is connected. So while the Gateway is down, notices still arrive and replies
do not. The helper's `status` shows the Gateway's state and, in the snapshot file, when that
state began (`since`) and since when the Gateway has not been ready (`notReadySince`: when it
last stopped being ready, or when it was started if it has not been ready yet; null while it is
ready). The first restarts on every attempt of an outage. The second is how long the outage
has lasted.

### Telling TangleClaw how the connection is

On every pass the helper tells TangleClaw how its Gateway connection is, inside the claim it
already makes: the state, the time to count from (when it became ready, or since when it has
not been), and Discord's close code if the connection was refused. Closed values only, like
the log. TangleClaw keeps the last report and says what it reads from it in
`tc bridge status` and in the bridge's two status payloads: connected, not connected, not
reported for more than three minutes, or never reported. The fields and the exact rules are in
[`operator-bridge.md`](operator-bridge.md#the-helpers-discord-connection).

Three things follow for whoever runs the helper:

- **A helper started before this was added reports nothing** and reads as never reported, or
  as not reported once the server has heard from a newer one. Restart it
  (`launchctl kickstart -k gui/$(id -u)/com.tangleclaw.bridge-helper`) after TangleClaw is
  updated.
- **A helper that is not running cannot say so.** Its last report goes stale after three
  minutes and then reads as not reported, which is all TangleClaw can know.
- **A pass that ends before the claim reports nothing.** While the helper cannot reach
  TangleClaw, or its token is refused, TangleClaw hears nothing and its reading goes stale in
  the same way.

A gateway Discord refused for good (`gateway-fatal`) reports `fatal` with the close code, and
keeps reporting it for as long as the helper runs. It does not retry: put right what the close
code names, then restart the helper.

## Operating it

- **`"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" status`** shows whether the config is set, whether each secret is
  present (never its value), whether the helper is running, the Gateway's state, the last pass,
  how many items are in progress, and any item held for you. It shows no secret, no message text and no Discord id.
- **The log** is `~/.tangleclaw/logs/bridge-helper.log`: one JSON line per event, with a
  timestamp, a closed code, and ids or numbers. It never holds message text, tokens, headers or
  Discord's raw answers. The codes are listed in `lib/bridge-helper/log.js`. Nothing rotates
  this file. It gets a line per message relayed and per failure, not per poll, so it grows
  slowly; truncate it or add a `newsyslog` rule if it matters.
- **After an update, restart it.** The helper is its own launchd job and keeps running the
  code it started with: updating and restarting the TangleClaw server does not restart it.
  `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.bridge-helper`, then read
  `gateway-ready` in the log.
- **Stopping:** `launchctl bootout gui/$(id -u)/com.tangleclaw.bridge-helper`. The job file
  stays, and launchd loads it again at your next login.
- **Starting again:** `"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" install-launchd`, by that whole path: it rewrites the job to run the
  helper it was started as.
- **Only one helper runs.** A second refuses to start, because two would post every item twice.
  The lock names a process id and counts only if that process is a helper, so a lock left by a
  helper that died is taken over even when something else now has its id.

## Removing it

```sh
"${TC_CHECKOUT:?set TC_CHECKOUT to the checkout the service runs from}/bin/tc-bridge-helper" uninstall-launchd
security delete-generic-password -s tangleclaw-bridge-helper -a bridge-helper-token
rm -r ~/.tangleclaw/bridge-helper
```

`uninstall-launchd` unloads the job and removes its file, and keeps the rest. Remove
`~/.tangleclaw/bridge-helper` only when `status` shows nothing held: it holds the record of
posts in progress. Then have the operator revoke the helper token at the bridge. The bot
token's Keychain item is not the helper's to remove: other things on this install use it.

## How an item is delivered

The helper **claims** what waits at the bridge. Each item comes under a two-minute lease
([operator-bridge.md](operator-bridge.md), "Claims and leases"), and with the parts of it that
are already posted, if an earlier attempt got part-way.

Before posting, the helper checks the item's text against the digest it was handed over with,
and the channel it names against the configured one.

An item is posted as **who it is from**, in bold, then the text as written. An answer is posted
as a reply to the operator's message. Text longer than one Discord message is posted as several,
in order.

The helper tells the bridge about **each message as soon as Discord has made it**, and then
acknowledges the whole set, which seals the item. Nothing is acknowledged before Discord has
confirmed it. Because each part is reported at once, a reply to any part is known for what it
answers straight away, and whoever picks the item up next carries on after the parts already
posted.

A lease does not make a post safe to repeat. Three things do, together: the bridge's record of
the parts already posted; the helper's own record, `~/.tangleclaw/bridge-helper/state.json`,
for an attempt whose outcome is in doubt; and the nonce each post carries, which Discord uses
to refuse a repeat for a few minutes.

| What goes wrong | What happens |
|---|---|
| Discord is busy, or the network is down | Nothing is acknowledged. The helper reports it as `transient`, backs off (to at most once every 5 minutes) and tries again. The item waits. |
| The helper posts, then cannot report or acknowledge | The post is on the helper's record. It reports and acknowledges on a later pass and never posts it again. |
| The lease lapses part-way through | The bridge hands the item over again with the parts already posted. The helper carries on after them. |
| The helper restarts, or loses its own record | The same: the bridge says which parts are posted. A restart also asks for the claim it was working on again, under its own nonce, and gets the same leases. |
| A claim's answer is lost | The claim is asked again under its own nonce. |
| A post's outcome is unknown (a timeout, a server error) | The helper reports `outcome-unknown` and retries with the same nonce for up to 2 minutes; Discord returns the message it already made. |
| Past those 2 minutes | A retry could duplicate the post, so the helper holds the item as `uncertain` and reports `outcome-unverifiable`. The bridge sets the item aside and tells you. |
| Discord rejects the item's content (HTTP 400) | The helper reports `rejected-by-chat`. The bridge sets the item aside and tells you. The items after it keep moving. |
| Discord says the chat is closed to the bot | The helper posts to one fixed channel, so it knows what a refusal means there: Discord's own codes for an unknown channel or server or for missing access or permissions, a refused bot token (401), a 403 with no code, or a 404 with no code for a post that named no message to reply to. It reports that, the bridge sets the item in hand aside and opens its configuration circuit, and nothing more is handed over until the Master or the operator resets it. |
| The message an answer replies to is gone, or Discord says 404 with no code for a reply | The answer is tried once more by itself, not as a reply, under the same nonce. If that posts, the channel is fine. If that is a 404 with no code too, it is the channel, and the circuit opens. If its outcome is unknown, the next pass settles it, still by itself. |
| Discord refuses with a 403 or 404 carrying a code the helper does not know, or with some other 4xx | That is this item's problem, never the channel's. Nothing was posted. The helper reports `outcome-unverifiable`, the bridge sets the item aside, and the helper keeps nothing. |
| Discord refuses while an earlier attempt for the same part is still in doubt | The refusal says nothing about whether the earlier attempt landed, so the item is held as `uncertain`, whatever the refusal was. It is never retried on that basis and never counted as posted. |
| Discord answers without a message id | It is never taken for a post. The attempt stays in doubt and is retried under the same nonce. |
| The bridge's record of an item's parts disagrees with the helper's | The helper reports `part-conflict` and posts nothing more of it. The bridge sets it aside. |
| The helper token was replaced | The old token's leases are no longer the helper's, and the bridge says nothing about their items. Items still waiting are handed to the new token with their parts. |
| The bridge let the item go, set it aside, or the Master withdrew it | The helper is not told which. Its lease is simply no longer live, and the item is not handed over again. Once the bridge holds every part the helper posted, the helper drops its own record. Anything already posted stays in the channel. |
| The record cannot be written | The helper posts nothing it could not record first, logs `state-write-failed` and tries again later. A part that did post before a write failed is remembered while the helper runs; if the helper also stops before it can write, the restarted helper finds the attempt on record as in doubt and falls back on the nonce, or holds the item as `uncertain`. |

One case leaves something behind. If the helper posted a part, could not report it, and the
bridge then let the item go, the bridge never hands that item over again and the helper's
record of the part stays where it is. `status` counts it under "in progress". It does no harm;
remove it by removing the record once nothing else is in progress.

## Items set aside

**The helper cannot discard anything.** What it cannot post, the bridge sets aside: the item
keeps its text, is handed to nobody, and one notice is posted in the channel saying that
something was set aside. The Project Master lists these with `tc bridge blocked` and decides:

- `tc bridge requeue <item-id>` puts the item back. The helper picks it up on its next pass
  (once any open configuration circuit has been reset) and
  carries on after any parts already posted.
- `tc bridge withdraw <item-id>` gives it up for good.

The operator can make the same two decisions from a signed-in session
([operator-bridge.md](operator-bridge.md), "The operator's routes").

For `rejected-by-chat` that is all there is to do: put right what Discord refused, then
requeue.

### When the whole chat is closed to the bot

If the channel or server is missing, the bot may not post there, or its token is refused, the
bridge opens its **configuration circuit**. The helper logs `bridge-configuration-blocked` on
every pass and posts nothing. The notice cannot reach you through Discord; `tc bridge status`
and `GET /api/bridge/operator/status` show it, and the server log carries a warning.

The Project Master is told of the open circuit and reports it at the workstation. While it
is open the Master can still release answers and approve candidates. They queue behind it.
**A release is not a delivery receipt:** nothing released
during an open circuit has reached you until the circuit is reset and the helper posts it.

Put the configuration right (the bot's permissions in the channel, or `set-secret bot` for a
new token, then restart the helper). Then the Master runs `tc bridge reset --requeue`, or
`--withdraw` to give up what was caught. Nothing closes the circuit by itself.

### Settling an `uncertain` item

`outcome-unverifiable` has two causes, and `status` tells them apart:

- **The item is listed as `uncertain`.** A post may have landed and the helper could not find
  out. Only you can see whether it reached the channel: settle it as below, then requeue.
- **The item is not listed.** Discord refused it outright in a way the helper could not place
  (`outbound-unplaceable` in the log, with the HTTP status). Nothing landed and the helper holds
  nothing, so there is nothing to settle: look at the refusal, then have the Master requeue the
  item or withdraw it.

For the first, `status` shows:

```
item 12: uncertain, part 2 (settle it: see docs/operator-bridge-helper.md)
```

Stop the helper, look in the channel, then run the one command that matches what you see.
`settle` refuses to run while the helper does.

| What you see | Command | What happens |
|---|---|---|
| The part did post. | `settle <id> --posted <discord message id>` | The id is recorded for that part. |
| The part did not post. | `settle <id> --repost` | The part will be posted again, under a new nonce. |

Then start the helper and have the Master run `tc bridge requeue <id>`. The helper reports the
part you recorded, posts any parts after it, and acknowledges the item.

"The part" is the one `status` names: with `part 2`, part 1 posted and is recorded, and part 2
is the one in question. `--posted` takes the id of that one part.

## Messages the operator sees when one is not taken

The helper replies to the message in fixed words and adds no ✅. Nothing of the message or of
TangleClaw's answer is echoed.

| The reply says | Why |
|---|---|
| the TangleClaw operator bridge is turned off | The bridge is disabled. |
| the bridge has no allowlist set | The operator has not set one. |
| TangleClaw does not allow this author, server or channel | The ids do not match the bridge's allowlist. |
| the text is over 8000 characters | The bridge's length limit. |
| the message has no text | An attachment or sticker with no text. |
| TangleClaw refused the helper's token | The token was replaced. Run `set-secret helper` with the new one. |
| TangleClaw could not accept this message | The bridge found the message malformed. |
| the helper is not reaching TangleClaw directly on its own machine | The bridge answers the helper only for a request made straight from this machine (`403 LOOPBACK_REQUIRED`). The helper's base URL points through a proxy or elsewhere; run `configure` again. |
| TangleClaw could not be reached | Three attempts failed or were over the bridge's rate limit, or the server answered with a redirect. Send it again later. |

## Troubleshooting by log code

| Code | Meaning and what to do |
|---|---|
| `config-missing`, `config-invalid` | Run `configure`. The helper exits with status 78 and contacts nothing. |
| `secret-missing`, `secret-read-failed` | Run `set-secret` for the secret `status` names. `secret-read-failed` can also mean the login Keychain is locked. |
| `state-unreadable` | `state.json` is damaged. The helper will not start without it, because forgetting a post in flight could make it twice. Move it aside only after checking the channel for what it names. |
| `state-write-failed` | `state.json` could not be written: a full disk, or permissions. The helper keeps trying and posts nothing it could not record. |
| `helper-already-running` | Another helper is running, or the helper could not check whether one is (`ps` failed): it does not start on a guess. With `pid: -1` the lock file `helper.pid` is unreadable. Either way, check that no helper runs (`pgrep -fl tc-bridge-helper`), then delete the lock file. |
| `gateway-connect-failed` | A connection to the Gateway failed before it opened: refused, a name that did not resolve, or no network. The helper tries again by itself, less often each time up to once a minute. Many in a row mean this machine cannot reach Discord. |
| `gateway-attempt-abandoned` | An attempt took more than 30 seconds to reach a ready session and was given up; `reached` says how far it got. The helper tries again by itself. See "When a connection attempt goes nowhere". |
| `gateway-watchdog-reconnect` | The helper had no connection and nothing scheduled, and the watchdog started an attempt. It recovers by itself, but nothing is known to cause it: report it, with the lines before it. |
| `gateway-fatal` | Discord refused the connection for a reason a retry cannot fix. 4004 is a bad bot token (run `set-secret bot`); 4014 means Message Content Intent is off. The helper keeps posting, but reads nothing until it is restarted. |
| `bridge-configuration-blocked` | The bridge's configuration circuit is open; see "When the whole chat is closed to the bot". |
| `outbound-chat-closed` | Discord said the chat is closed to the bot, and the bridge was told. The line carries the reason chosen. |
| `outbound-reply-target-missing` | The message an answer replied to may be gone; the answer is being tried once more by itself. The next line for that item says how the retry went. |
| `outbound-unplaceable` | Discord refused an item in a way the helper could not place. Nothing was posted; the bridge set the item aside. See "Settling an `uncertain` item" for the two cases. |
| `claim-failed` | The bridge could not be asked what to post. The status is in the line: `0` is no answer, `401` a replaced token, `409` a disabled bridge, `400` a claim the bridge calls malformed. A `400` on every pass means the bridge refuses this helper's report of its Discord connection (`BAD_GATEWAY_REPORT` in TangleClaw's own log, as `Bridge request refused`): the helper and TangleClaw are from different versions. Nothing is posted while it lasts. Update and restart the helper. |
| `redirect-refused` | A server answered with a redirect, which the helper never follows. Check `--base-url`. |
| `outbound-uncertain` | An item is held here and set aside at the bridge; see "Settling an `uncertain` item". |
| `outbound-rejected`, `outbound-part-conflict` | The bridge was asked to set an item aside; see "Items set aside". |
| `outbound-report-failed` | The bridge could not be told that an item could not be posted. It is told again on the next pass. |
| `outbound-ack-failed` | A posted item could not be reported or acknowledged: the bridge did not answer, the helper's lease on it is no longer live, or the item was withdrawn or set aside at the bridge in the meantime (`409 ACK_NOT_APPLIED`). The helper does not post it again. If the item is still waiting it is handed over again and acknowledged then. |
| `outbound-digest-mismatch`, `outbound-foreign-channel` | An item did not pass the helper's checks and was not posted. Either is a defect to report. |
| `outbound-pass-failed` | A pass ended on a failure the helper did not expect. The line gives the failure's type and never its message. Report it, with the lines around it. |

## What is not proven here

The automated tests cover every rule on this page against the real bridge routes and a
stand-in for Discord (`test/bridge-helper-*.test.js`). These need the operator's own Mac and
Discord account, and belong to the live verification before cutover:

- the Keychain items and the launchd install, restart and throttle;
- that Discord honours the nonce as documented, for how long;
- the Gateway against Discord itself: identify, resume, and the close codes;
- a connection attempt that goes nowhere against Discord itself. Discord cannot be made to
  stall on demand, so this is proved against Node's real WebSocket and loopback servers that
  refuse, accept and say nothing, or complete the handshake and say nothing
  (`test/bridge-helper-gateway.test.js`), and not against Discord;
- the helper's report of its connection, against Discord itself: the tests drive the real
  gateway module through every state over a stand-in socket and hold each report to the
  server's rule, but what the live helper reports during a real outage has not been watched;
- one two-way conversation, and one of each notification.

## Code

- `bin/tc-bridge-helper`: the launcher.
- `lib/bridge-helper/cli.js`: the commands.
- `lib/bridge-helper/config.js`, `secrets.js`, `state.js`, `log.js`: the config, the Keychain,
  the record of posts and the closed-code log.
- `lib/bridge-helper/bridge-client.js`: the helper routes listed in
  [operator-bridge.md](operator-bridge.md), and nothing else.
- `lib/bridge-helper/discord-rest.js`, `discord-gateway.js`: Discord's REST API and Gateway.
  `discord-gateway.js` is carried over from the helper written for #1799, which never merged.
  That is this project's own earlier work, kept because it speaks only Discord's protocol. It
  inherits nothing from the contract #1799 was written against, and is reviewed as new code.
- `lib/bridge-helper/inbound.js`, `outbound.js`: the two directions.
- `deploy/com.tangleclaw.bridge-helper.plist`: the launchd job's template.
