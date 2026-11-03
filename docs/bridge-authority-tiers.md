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
to this module; `digestFor` is a convenience SHA-256 helper, not a requirement), and `version`,
expiring at `expiresAt`. It returns the record once, carrying a 32-byte random `nonce` — the
bearer secret. That nonce is never retrievable again after this call; **it is never persisted at
all** — only `digestFor(nonce)` (a SHA-256 hex digest) is written to the `nonce_hash` column
(PRR-A I-Gate R1 finding 2, below). A reader of a confirmation record by any other path never
sees the raw nonce, and neither does a direct read of the database file.

`verifyAndConsumeConfirmation` is the one state-transition primitive. It does not itself check
WHO is presenting the confirmation — proving that is each trust boundary's own job, the same split
[`lib/permission-requests.js`](../lib/permission-requests.js)'s `decidePermissionRequest`
documents for its own two trust boundaries. It enforces, in order:

1. **No nonce presented** → `SAME_USER_CONFIRMATION_REQUIRED` — #2106's own code for a caller
   that lacks the bound confirmation entirely (an unrelated same-user process with no card).
2. **A nonce presented but resolving to nothing** (looked up by `digestFor(presented.nonce)`
   against `nonce_hash`, never by the raw value) → `CONFIRMATION_INVALID`.
3. **Already consumed** → `CONFIRMATION_REPLAYED`. A card is single-use, full stop: unlike a
   permission-request decision (where the same decision replayed is an idempotent success), a
   confirmation card authorizes something irreversible, so a second presentation is rejected every
   time — the rejection is idempotent, the authorization never is.
4. **Expired** (lazy transition, applied and persisted on this read) → `CONFIRMATION_EXPIRED`.
5. **Operator, guild or channel does not match** → `CONFIRMATION_SCOPE_MISMATCH` — WHO this card is
   bound to and WHERE it was issued are both "scope" in the same sense; presenting a valid nonce
   under a different operator is the same class of mismatch as a different guild or channel.
6. **Action, target, digest or version does not match** → `CONFIRMATION_DIGEST_MISMATCH` — a
   mismatched `actionKind` (a card issued for one action does not authorize a different one) and a
   stale `version` (PRR-A I-Gate R1 finding 1) are both "this card does not authorize what is being
   acted on now", the same class of mismatch as a wrong target or digest.

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

**Also explicitly in scope (PRR-A I-Gate R1 finding 2): that same process reading
`~/.tangleclaw/tangleclaw.db` directly.** `tangleclaw.db`'s mode (`0600`) restricts other *users*,
not this one — an unrelated same-user process can open and read the file with ordinary filesystem
calls, no SQL injection or privilege escalation needed. If the raw nonce were stored, a plain
`SELECT` over the file would hand that process a usable bearer token for any still-pending
confirmation card. Storing only `nonce_hash` (a SHA-256 digest) closes this specific read path:
the attacker can read the digest but cannot invert it back to the bearer secret
`verifyAndConsumeConfirmation` actually checks against.

Out of scope for this module (unchanged from the v5.31.0 boundary, and not widened or narrowed by
this slice): compromise of the operator's own macOS account entirely; a process with direct SQLite
**write** access (it could insert, update or delete rows outright, the same way it could already
forge most other state this product persists — no confirmation-card mechanism defends against an
attacker who can rewrite the database, only against one who can merely read it); the Discord
gateway's own authenticity — this module trusts whatever `operatorId`/`guildId`/`channelId` it is
handed, and verifying those came from a genuine Discord message is the caller's job (Slice 2's
`lib/bridge-api.js` wiring).
`ordinary-work` tier actions carry no new protection here at all — they rely entirely on the
bridge's existing allowlist check (`operator-bridge.md`), unchanged by this issue.

## Activation and rollback

Nothing in this module activates anything by itself: its tables are created lazily on first use
and its functions are pure library calls with no route bound to them yet (Slice 1). There is
nothing to roll back until Slice 2 wires a route to call them — at that point, rollback is
reverting that route's own call site; the two tables stay inert (never read) if untouched.
