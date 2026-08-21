# The completion test: project rule "Medusa delivery gaps", after the train

**Status:** ready to apply. **Not applied** — this is operator-authored content
(session rule id 12, `kind=startup`), and it goes live to every session in the
fleet the moment it changes.

The v5.13.0 train's done-condition was that this rule could shrink. Steps 1–4
were workarounds for defects; cars 1–6 retired them. Steps 5–6 are collaboration
norms and survive.

## What retired what

| Step | Retired by |
|---|---|
| 1. Keep your own watermark (`read` is advisory) | Car 1 — `POST …/read {ids}` removes handled mail from the inbox (#784, #1090) |
| 2. Verify delivery, never assume it | Car 2 — every nudge outcome is recorded; `GET /api/medusa/deliveries` answers it fleet-wide (#792/#791, #1091) |
| 3. Check the prompt before injecting | Car 1 — `sendKeys` clears the prompt and logs the draft first (#812, #1090) |
| 4. tmux targets must be exact | Cars 3–4 — the fleet gate keeps a nudge out of a subagent (#783), and a rotated handle is re-resolved rather than reported as a missing peer (#1023) |
| 5. Consent is not optional | **stays** — a norm, not a defect |
| 6. Instruct the peer to VERIFY rather than recall | **stays** — a norm, not a defect |

## Proposed replacement text

> **CROSS-SESSION EXCHANGES ON THE SWITCHBOARD.** The delivery gaps this rule
> used to work around are closed (v5.13.0, #818). Two things remain true and are
> not defects, so they stay rules.
>
> 1. **CONSENT IS NOT OPTIONAL.** Peeking at or injecting into another session's
>    pane is authorised only for a target the operator has named for this
>    exchange. An idle-looking pane is not a free session — if it is mid-work on
>    its own branch, a nudge is an interruption. Say so in the nudge, and close
>    the loop when done: **the initiator closes.**
>
> 2. **TELL THE PEER TO VERIFY, NOT TO RECALL.** Ask for a live probe rather than
>    an answer from memory — the exchange that produced this rule corrected a
>    wrong assumption about standing egress precisely because the peer checked
>    instead of remembering. And say plainly that you want a yes/no: a clean "no"
>    is worth more than a clever workaround, especially where the workaround
>    would introduce an unaudited credential.
>
> **What changed, so you can stop compensating:** a message you mark handled
> (`POST …/medusa/read {"ids":[…]}`) leaves the inbox — no private watermark
> needed. Every nudge outcome is on the record; `GET /api/medusa/deliveries`
> lists participants whose newest mail nobody was told about. Injection clears
> the prompt first, refuses a pane with a running subagent, and a peer's rotated
> workspace id is re-resolved rather than failing as a missing peer.
>
> **Still open, and still yours to watch:** a consumer that only ever sends a
> bodyless `read` accumulates mail Hub-side — the agent-side handled report is
> owed. `Medusa#64` orphans a queued message when A2A renames it, so
> TangleClaw#934 tracks redelivery that a correct ACK cannot stop. And nothing
> yet stamps a message with which actor inside a workspace sent it
> (TangleClaw#1025 — unbuildable from TangleClaw; Medusa builds the envelope
> from a fixed field whitelist).

## How to apply

Edit session rule **id 12** for the TangleClaw project — the landing page's
rules editor, or `PUT /api/session-rules/12`. It is `kind=startup`, so it takes
effect for sessions launched after the change; running sessions keep the old text
until they relaunch.
