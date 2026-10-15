# Discord operator notifications

Status: **the bridge shipped in v5.31.0; cutover is per install.** The Master-mediated bridge is
off by default; the operator enables it by completing
[Activate the operator bridge](runbooks/activate-the-operator-bridge.md). The direct procedure below
applies only on an install with an existing, explicitly authorized direct procedure. A fresh install
has no direct posting authority by default: its active rules govern routing.

On the project's own install, whose rule store numbers them, Rule #188 was activated at
2026-10-06 04:14:43Z and Rule #145, the direct procedure's rule, was retired at
2026-10-15 20:50:39Z. Those numbers are that installation's historical identifiers: these
identifiers are installation-local and must not be assumed on another install. Outbound posts
through the bridge are proved there; one fresh operator
message carried through to the Project Master and answered back is not yet (#1836), and an
incomplete verification does not revive a retired rule. See [operator-bridge.md](operator-bridge.md)
for what is built.

There are two ways an operational message reaches the operator's Discord. They are sequential,
not parallel: the first is retired when the second goes live.

| | Direct (only where an existing rule authorizes it) | The bridge (shipped in v5.31.0, off until the operator enables it) |
|---|---|---|
| What it is | The Architect session posts to Discord by hand | The Master-mediated bridge |
| Governed by | The operator's rule for it (Rule #145 on the project's own install, now retired) | [ADR 0023](adr/0023-master-mediated-operator-bridge.md), and the installation's active rule for it |
| Who decides what is sent | The Architect | The Project Master session |
| Who posts | The Architect, and nobody else | The Discord helper, a local process |
| Direction | Outbound only | Both ways |
| Tracked in | #2040 | #2031, #1956, #1799 |

If you are a session with something the operator should see in Discord: on an existing install,
continue only the notification path its active rules authorize; on a fresh install, configure and
authorize the bridge before using it. Do not treat this page as permission to post directly.

## Interim procedure — only where an existing rule authorizes it

This is the direct path as Rule #145 set it out on the project's own install, where that rule was
held on the Architect's project and was the authority until it was retired. On an install whose
active rules still authorize a direct path, that rule is the authority. This page describes it so the
procedure survives a session clear. If the two disagree, the rule wins and this page is the bug.

### Who may send

- **The Architect is the sole Discord sender** for TangleClaw operational messages.
- **Every other session never sends to Discord directly.** That covers the ProjectManager,
  Builders and Reviewers.
- **If the Architect is unavailable, messages queue in Medusa.** No session bypasses the
  Architect because it is busy.

### What another session does instead

Send the Architect a candidate notification over Medusa. It carries:

- the notification class: `milestone` or `operator-action-required`;
- the verified facts and their receipts;
- issue, PR and rule numbers, and the exact SHA where one applies;
- the precise action required from the operator, or `none` stated explicitly;
- urgency or deadline;
- the Discord message id of any earlier notification this one corrects.

### What the Architect does before sending

- Validates the facts.
- Rejects stale or conflicting instructions.
- Removes operator requests that are not needed.
- Consolidates duplicates.
- Makes sure every rule a message refers to is cited by its Rule number.

Milestones and real operator actions are sent. Routine chatter is not.

### How the Architect sends

1. **Read the bot token at send time, from the macOS Keychain:**

   ```
   security find-generic-password -s tangleclaw-discord-helper -a discord-bot-token -w
   ```

2. **Keep the token out of everything else.** It never appears in a command's arguments, in
   Medusa, in a repository, in documentation, in an environment variable, in a log or in error
   text. Pass it to the HTTP client on standard input.
3. **Post to the Discord API v10 `messages` endpoint of the designated channel,** with `Bot`
   authorization, mentioning the operator. Use a stable nonce with `enforce_nonce` for each
   attempt.
4. **Confirm delivery.** A send counts only when Discord answers HTTP 200 with a message id, and
   a `GET` of that exact message from the designated channel shows the content and the mention
   the Architect intended.

The designated channel id and the operator's Discord user id are stated in the authorizing rule
(Rule #145 on the project's own install) and in #2040. They are deliberately not repeated in this file.

### When the operator says nothing arrived

Verify the channel and the message first. A post that exists is a Discord client notification
failure, not a missing post. When a resend is useful, send one corrected message with a new
nonce.

### What the interim path does not do

- **It carries nothing back.** A reply the operator writes in Discord is not assumed to reach
  TangleClaw.
- **It is not an authority channel.** Nothing written in Discord approves a merge, a release, a
  deletion or a credential change.

## Future path — the Master-mediated bridge

[ADR 0023](adr/0023-master-mediated-operator-bridge.md) records the rulings. In outline:

1. The Discord helper authenticates, applies the allowlist, and durably delivers the operator's
   message to the Master gateway, which is server code.
2. The gateway works out where the message looks to be going, from a reply, a pin, an exact
   alias or the default, and records that as a suggestion. It sends the message nowhere.
3. The Project Master session routes every message, to the suggested place or another. An
   unaddressed message is suggested for the Master itself, which routes it to itself and
   answers it, or routes it to a project.
4. A correlated, tracked Medusa message goes to the target session, and its correlated reply
   comes back to the gateway and is held there.
5. Master releases the answer, using that reply as its source. Nothing from a target session
   goes straight to Discord.
6. The answer returns through the helper to the original Discord conversation.

The helper acknowledges a message as soon as it is durably received. If there is no final answer
after 5 minutes, the operator gets at most one pending notice. Nothing repeats.

If Master is unavailable the message is kept and the operator is told it is queued. It does not
fall back to the Architect.

Neither the gateway nor the Master session is authority, and Discord still cannot approve a
reserved action.

### What a session with news for the operator will do then

Much the same as today, with Master in the Architect's place. A verified session submits a
candidate `milestone` or `operator-action-required` item to Master, with its facts and receipts.
Only Master validates it, consolidates it and turns it into something the gateway may send. No
project session posts to Discord directly.

Besides those items, only three other things reach Discord: a reply to something the operator
wrote, a delivery failure, and the typed server notifications `operator-needed`, `work-blocked`,
`fleet-idle`, `lane-silent`, `gateway-down` and `gateway-recovered`. The last two are about the
helper's own connection to Discord: the server queues the first once the helper has reported no
connection for five minutes, and the second once when that outage ends
([operator-bridge.md](operator-bridge.md), "Server notifications").

### What carries over unchanged

Secrets only in the Keychain, exact allowlists, stable ids and nonces, acknowledgement only after
Discord confirms the post, display safety, a scoped token, the conversation-is-not-authority
fence, and no channel or user id in a tracked document.

## Cutover

The bridge is disabled by default. The operator enables it locally, and that enablement is also
the consent for an inbound Discord message to start the Master session.

Cutover happens only when both of these are true:

1. **Where an older direct rule exists, it has been replaced, with the operator's approval.** This
   is the historical migration case: on the project's own install the rule was Rule #145, which
   referred to PR #2003 (closed as superseded on 2026-10-04). Rules are changed through the rule
   store, not by editing this page, and the installation's active rules are the policy. A fresh
   install has no older rule to replace.
2. **The new transport has passed a live round trip and its security verification.**

At cutover:

- **After a rollback, one narrow fallback.** The rule that replaces an older direct rule (Rule #145 on
  the project's own install) says so itself: while the bridge is disabled or rolled back the helper sends nothing, and the
  Architect alone may use the former direct route for milestones and genuine
  operator-action-required notices until the bridge is enabled again. That uses the send steps of
  the interim section above,
  under the new rule's number. No rule is edited to roll back.
- **The interim procedure is retired, not merged into the new path.** This page's interim section
  is kept for one use only: the rollback fallback above.
- **The Architect leaves the routine delivery path** and keeps architectural and governance
  oversight. Master becomes the sole filter and router, and the helper the sole Discord sender.

Until cutover, nothing here changes who may post. A helper that exists on a branch is not a live
transport.
