# Bridge action authority tiers

How the operator bridge decides what a bridge-originated action may do without further proof,
and what it must bind a single-use confirmation to before it may do more. `lib/bridge-confirmation.js`
is the implementation; Architect Rulings `A2106` and `A2116` (issues #2106, #2116) are the design
authority this page records.

## Status

Slice 1 (`v5.59.0`, this module): the classification and confirmation-card data model and
primitives — `classifyBridgeActionTier`, `createActionConfirmation`,
`verifyAndConsumeConfirmation`. **Not yet wired to a live route.** Slice 2 (`#2842`, `v5.60.0`)
wires live HTTP endpoint hooks into `lib/bridge-api.js` and the dashboard step-up modal into
`public/*`, kept out of this slice so Car 59-C stays 100% file-disjoint from the same wave's
Car 59-A (`lib/bridge-api.js`) and Car 59-B (`public/*`). Nothing in this module is reachable
from a real bridge message until that wiring lands.

## Why this exists

The v5.31.0 operator bridge activation (see [operator-bridge.md](operator-bridge.md)) accepted a
residual trust gap: a same-user local process can originate an inbound message as the operator,
and the boundary at that time trusted the operator's macOS account as a whole. Issue #2106 asked
for a stronger boundary on the highest-impact actions (launch consent, nickname mutation).
Issue #2116 asked for a broader, bounded way to extend REAL action authority to Discord for
routine work, while keeping the reserved tier (merge/release/deploy/credential/rule change)
behind something stronger than chat text.

The three tiers below are the answer to both: ordinary work needs no new ceremony, sensitive
actions need a confirmation card, and the most sensitive need a dashboard step-up unless the
operator has explicitly accepted Discord-only risk for that one category.

## The three tiers

| Tier | Action kinds | What authorizes it |
|---|---|---|
| `ordinary-work` | `investigate`, `plan`, `implement`, `test`, `file-issue`, `file-pr`, `status`, `route`, `dispatch` | Verified allowlisted operator Discord input, same as any other input channel. `classifyBridgeActionTier` returns `authorized: true` directly — no further mechanism in this module. |
| `confirmation-card` | `merge`, `release`, `deploy`, `session-lifecycle`, `launch-consent`, `nickname-mutation` | A single-use confirmation card (below), bound to the exact operator, guild, channel, action, target and digest. |
| `step-up` | `data-deletion`, `credential-change`, `permission-change`, `rule-change` | A short-lived dashboard step-up token (Slice 2), unless the operator has recorded an explicit opt-in override for that one category — which falls the action back to `confirmation-card`, not to no authorization at all. The operator accepted Discord-only **risk**, not Discord-only **trust**. |

`classifyBridgeActionTier(actionType, opts)` only classifies. A caller that receives
`tier: 'confirmation-card'` or `tier: 'step-up'` still must obtain and verify the matching proof
before acting — this function never itself authorizes either tier. An action type this module has
no policy for refuses closed (`BRIDGE_ACTION_TYPE_UNKNOWN`) rather than defaulting to
`ordinary-work`; a silent default was the exact gap #2106 exists to close.

## The confirmation card (`confirmation-card` tier)

`createActionConfirmation` issues a record binding `operatorId`, `guildId`, `channelId`,
`actionKind`, `targetRef`, `digestSha` (the exact SHA/digest of what is being acted on — opaque
to this module; `digestFor` is a convenience SHA-256 helper, not a requirement), `version`, and an
`expiresAt`. It returns the record once, carrying a 32-byte random `nonce` — the bearer secret.
That nonce is never retrievable again after this call; a reader of a confirmation record by any
other path never sees it.

`verifyAndConsumeConfirmation` is the one state-transition primitive. It does not itself check
WHO is presenting the confirmation — proving that is each trust boundary's own job, the same split
[`lib/permission-requests.js`](../lib/permission-requests.js)'s `decidePermissionRequest`
documents for its own two trust boundaries. It enforces, in order:

1. **No nonce presented** → `SAME_USER_CONFIRMATION_REQUIRED` — #2106's own code for a caller
   that lacks the bound confirmation entirely (an unrelated same-user process with no card).
2. **A nonce presented but resolving to nothing** → `CONFIRMATION_INVALID`.
3. **Already consumed** → `CONFIRMATION_REPLAYED`. A card is single-use, full stop: unlike a
   permission-request decision (where the same decision replayed is an idempotent success), a
   confirmation card authorizes something irreversible, so a second presentation is rejected every
   time — the rejection is idempotent, the authorization never is.
4. **Expired** (lazy transition, applied and persisted on this read) → `CONFIRMATION_EXPIRED`.
5. **Guild or channel does not match** → `CONFIRMATION_SCOPE_MISMATCH`.
6. **Action, target or digest does not match** → `CONFIRMATION_DIGEST_MISMATCH` — this also covers
   a mismatched `actionKind`: a card issued for one action does not authorize a different one,
   whatever its target and digest.

A rejected mismatch (scope or digest) does **not** consume the card — a caller that mistypes a
field and retries correctly still gets the single real use. Only a successful verify consumes it.

Every create, consume and rejection is written to `bridge_action_audit`
(`outcome`, `code`, the binding fields, `detail`), whether or not it resolved to a real
confirmation record — a rejected nonce that matches nothing still leaves an audit trail with
`confirmation_id: null`.

## Storage

Two tables, additive, owned entirely by `lib/bridge-confirmation.js`:
`bridge_action_confirmations` (the confirmation records) and `bridge_action_audit` (every
classification/confirmation outcome). Both are created via `CREATE TABLE IF NOT EXISTS` directly
in the module, on `store.getDb()` — **not** through `lib/store/_schema.js`'s migration chain, so
this slice claims no schema number. A future slice that needs to ALTER either table's shape (not
just add a sibling table) will need a real migration at that point.

## Local attacker / trust model

In scope for this module: an unrelated process running under the operator's own macOS user id
that can originate requests shaped like a bridge inbound, but holds no confirmation nonce for a
`confirmation-card`-tier action and no step-up token for a `step-up`-tier one. That process is
mechanically refused — it cannot fabricate a valid nonce (32 bytes of `crypto.randomBytes`,
never derivable from the action's own public fields) and cannot replay a nonce it has observed
once already consumed.

Out of scope for this module (unchanged from the v5.31.0 boundary, and not widened or narrowed by
this slice): compromise of the operator's own macOS account entirely; compromise of the database
itself (a process with direct SQLite write access could insert a row, the same way it could
already forge most other state this product persists); the Discord gateway's own authenticity —
this module trusts whatever `operatorId`/`guildId`/`channelId` it is handed, and verifying those
came from a genuine Discord message is the caller's job (Slice 2's `lib/bridge-api.js` wiring).
`ordinary-work` tier actions carry no new protection here at all — they rely entirely on the
bridge's existing allowlist check (`operator-bridge.md`), unchanged by this issue.

## Activation and rollback

Nothing in this module activates anything by itself: its tables are created lazily on first use
and its functions are pure library calls with no route bound to them yet (Slice 1). There is
nothing to roll back until Slice 2 wires a route to call them — at that point, rollback is
reverting that route's own call site; the two tables stay inert (never read) if untouched.
