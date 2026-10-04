# Discord operator notifications

Status: **interim procedure in force.** The permanent transport is designed and not built.

There are two ways an operational message reaches the operator's Discord. They are sequential,
not parallel: the first is retired when the second goes live.

| | Interim (in force now) | Future (not built) |
|---|---|---|
| What it is | The Architect session posts to Discord by hand | The Master-mediated bridge |
| Governed by | The operator's Rule #145 | [ADR 0023](adr/0023-master-mediated-operator-bridge.md), once accepted |
| Who posts | The Architect, and nobody else | The Discord helper, a local process |
| Direction | Outbound only | Both ways |
| Tracked in | #2040 | #2031, #1956, #1799 |

If you are a session with something the operator should see in Discord today, read "Interim
procedure". Do not read "Future path" as something you can use: none of it exists on `main`.

## Interim procedure — until the Master-mediated bridge ships

This is the direct path under Rule #145. Rule #145 is an operator rule in TangleClaw's rule
store, held on the Architect's project, and it is the authority. This page describes it so the
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

The designated channel id and the operator's Discord user id are stated in Rule #145 and in
#2040. They are deliberately not repeated in this file.

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

[ADR 0023](adr/0023-master-mediated-operator-bridge.md) records the ruling and the proposed
contract. In outline:

1. The Discord helper authenticates, applies the allowlist, and durably delivers the operator's
   message to the Master gateway.
2. Master resolves the destination: the one the operator addressed, or the default.
3. Master sends a correlated, tracked Medusa message to the target session.
4. The session's correlated reply returns to Master.
5. Master applies the operator-notification and filter policy.
6. The result returns through the helper to the original Discord conversation.

Master coordinates routing and transport. It is never authority, and Discord still cannot
approve a reserved action.

What carries over unchanged from the interim path: secrets only in the Keychain, exact
allowlists, stable ids and nonces, acknowledgement only after Discord confirms the post, display
safety, a scoped token, and the conversation-is-not-authority fence.

## Cutover

- **The interim procedure is retired, not merged into the new path.** At cutover this page's
  interim section is removed or marked historical.
- **Rule #145 needs its own update at that point.** Its text names PR #2003 as the moment the
  transport is replaced, and that PR was closed as superseded on 2026-10-04. It also says the
  Architect remains the sole filter and sender after the transport changes, which the
  Master-mediated design has to be reconciled with (ADR 0023, Q4). Rules are changed through the
  rule store by the operator, not by editing this page.
- **Until cutover, nothing here changes who may post.** A helper that exists on a branch is not
  a live transport.
