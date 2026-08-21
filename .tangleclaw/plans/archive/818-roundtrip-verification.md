## Live two-session round trip — PASSED, 2026-08-21

The verification bar this plan set and nothing in the six cars had met: *a green suite is not evidence a message arrived.* Run against the **Medusa** session (`medusa-94d4f3bb`, antigravity/Gemini) from `tangleclaw-d21f8c11`, on the running v5.13.0 install, with the operator naming the target.

**Preconditions checked before trusting anything.** `/api/version` reads a file off disk and proves nothing about the loaded process, so the running build was confirmed behaviourally instead: car 2's new `GET /api/medusa/deliveries` answered `200` (a stale `server.js` would 404 it) and car 5's `enabled` field was present on the status payload.

### What the peer confirmed — by probing, not recalling

| | |
|---|---|
| **A handled message leaves the inbox** (#784/#785) | Medusa ran `GET messages` → `POST read {"ids":[…]}` → `GET messages` again and reported the second GET returned an **empty array**. Confirmed independently from our side too: our inbox went to 0 after handling its reply. |
| **The nudge states a usable base URL** (#1020) | *"It specifically said `Fetch them from the TangleClaw API at http://localhost:3102:` rather than pointing at the project guide."* Confirmed from the receiving end, which is the only place it matters. |
| **The reply obligation works** (#912) | The reply itself is the evidence. The old nudge never named `send`, and an initiator in this position simply hung. |

### What the delivery ledger recorded, unprompted (#792/#791)

The nudge that carried the message: `nudged · tmux-inject · key=fe552e6d-282 · unread=1`, keyed to the exact message id.

And the fleet query answered #792's original question with real data on its first day — **4 participants sitting on mail nobody was told about**, each with an honest reason:

- `unprofiled-engine` — no wake profile, skipped and logged rather than silently dropped
- **`pane-agents-running`** — car 3's #783 gate firing **in production**, refusing to type into a session with a running subagent fleet. Without it that nudge would have landed in a subagent's composer.
- `pane-no-bare-prompt` ×2 — busy or at a dialog

Before this train, all four of those were silent, and indistinguishable from "nobody sent anything."

### Also observed live
- `retargetedFrom: null` on both sends — car 4's field is in the response shape.
- The nudge text carried car 1's `{"ids":[...]}` handled semantics, car 6's real origin, and #912's initiator-closes contract, in one line.

### Loop closed
Closed by the **initiator**, per the norm that survived the rule rewrite. Nothing left outstanding on the Medusa session.

### Not covered by this run
A peer **restart** mid-exchange (#1023's re-resolution path) — the round trip never rotated a workspace id, so that car remains test-verified only.
