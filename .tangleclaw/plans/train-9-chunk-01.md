# Train 9 — Chunk 01: the user store, and the questions that block the gate

**Issues:** #1416 (ADR addendum), #1417 (store)
**Branch:** `feat/1416-1417-tier1-auth-store`
**Worktree:** not required — this chunk touches neither `public/` nor `server.js`, which is what
the project's live-install rule scopes the worktree mandate to. Chunks 02-04 do touch them and
will run in one.
**Critic mode:** chunk
**Size:** medium
**Train plan:** `.tangleclaw/plans/train-9-tier1-auth-chunking.md`
**Baseline:** suite green at `b1b482cb` — 8747 tests, 0 fail, exit 0.

---

## Confidence check

**Problem.** ADR 0015 is Accepted and unbuilt. A direct-mode TangleClaw install has no login at
all: `lib/store.js:133` says the credential only takes effect in caddy ingress mode, so
`basicAuthUser`/`basicAuthHash` in a direct-mode config enforce nothing. Before any of that can be
fixed, three of the ADR's open questions have to be decided, and there is nowhere to put a user.

**Success.** (1) An addendum answers OQ1/OQ2/OQ3 and the migration mechanism, with reasoning, so
chunks 02-04 build against decisions rather than guesses. (2) TangleClaw has a `users` table and a
single owner for scrypt hash/verify, exercised by tests, with **no operator-visible change** — no
route, no gate, no login. This PR can merge into the live install and nothing behaves differently.

**Out of scope.** Sessions, cookies, login routes, CSRF, the WebSocket upgrade, removing Caddy's
gate, the bcrypt→scrypt migration *build* (decided here, built in chunk 04), and every tier-2
concept (resource defaults, `project_members`, engine filtering, usage limits).

---

## Two scope decisions made during discovery — recorded, not silently taken

### 1. `scripts/reset-admin.js` keeps its Caddy contract this chunk

#1417 as filed says reset-admin "learns the new store". Reading it first changed the shape:
`scripts/reset-admin.js` is the **Caddy** break-glass tool — it regenerates a bcrypt hash, patches
the live Caddyfile in place, `caddy validate`s fail-closed, reloads Caddy, and syncs the persisted
config (`lib/admin-credential.js`, `lib/caddy.js`). That is recovery for the gate that exists today.

Adding a store-backed mode now would build a recovery path for a door that is not installed until
chunk 02, and it could not be verified end to end. So:

- **This chunk** lands the store-layer user operations that both callers need — create, look up,
  set password, verify.
- **Chunk 02** adds the CLI surface, alongside the gate it recovers. ADR 0009 rule 5 (recovery stays
  a terminal tool outside the gate) is satisfied there, when there is a gate to be outside of.

Not dropped — moved one chunk, with the seam named.

### 2. A real defect in the primitives being extracted

`lib/projects.js:77`:

```js
return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
```

`crypto.timingSafeEqual` **throws** on unequal buffer lengths. `derived` is always 64 bytes; `hash`
comes from the stored string, and `Buffer.from(x, 'hex')` silently truncates at the first invalid
pair — so a corrupt, truncated or hand-edited stored value makes `verifyPassword` **throw instead of
returning false**.

This repo already knows the hazard and solved it once: `lib/service-token.js:103-114` guards length
first and documents why ("token length is not the secret"). The project-delete path it currently
guards turns this into a 500; on the login path it is a crash on a malformed row.

Fixed as part of the extraction, with a regression test. No "pre-existing" exception — and the fix
belongs here rather than later precisely because this is the chunk that makes these primitives
shared.

---

## Deliverables

### 01a — `docs/adr/0016-tier-1-auth-build-decisions.md` (#1416)

An addendum to ADR 0015, answering with reasoning:

- **OQ1 — cookie or bearer.** Must be checked against `server.js:6353` (`handleUpgrade`), not
  assumed from the same-origin dashboard. Binds chunks 02 and 03.
- **OQ2 — `X-Auth-User` / AUTH-3.** `lib/auth-identity.js` exists to reason about a header
  `lib/caddy.js:276` populates. Say what it becomes.
- **OQ3 — `authEnabled`.** From "no Caddy gate" to "no TangleClaw session required", preserving
  ADR 0009's deliberate opt-out.
- **The migration mechanism.** bcrypt `basicAuthHash` → scrypt, forced once, with no window in
  which the door is open.

New ADR rather than an edit to 0015, per this repo's ADR governance: 0015 is Accepted and its
reasoning stays readable as written; 0016 records what the build decided.

### 01b — `lib/password.js` (#1417)

One owner for scrypt hash/verify. `hashPassword` / `verifyPassword` move here verbatim except for
the length guard above; `lib/projects.js` imports them instead of defining them. Keeps the existing
`salt:hash` hex format — it is already persisted by `config.deletePassword`, so changing it would be
a migration for no benefit.

### 01c — `users` table, schema v35 → v36 (#1417)

Columns: `id`, `username` (UNIQUE), `password_hash`, `created_at`, `disabled_at` (NULL = active).
Salt lives inside `password_hash` in the existing `salt:hash` format, so no separate column.

Follows the v34→v35 pattern at `lib/store.js:1899` exactly: conditional `ALTER`/`CREATE` because
`_createTables` runs before migrations, a `BEGIN IMMEDIATE` transaction, an explicit **postcondition**
read back from `sqlite_master` before `schema_version` advances, and `ROLLBACK` on failure.

Deliberately NOT included: `role`. ADR 0015 is explicit that the only genuine tier-1 distinction is
authenticated vs not, and that "Admin" is the operator's word for a tier-2 concept. A `role` column
added now would be a security-shaped field that nothing checks — the exact drift the ADR's tier
split exists to prevent. It arrives with tier 2 or not at all.

### 01d — Store-layer user operations (#1417)

`createUser`, `getUserByName`, `setUserPassword`, `verifyUser`, `listUsers`, `disableUser`. Called by
chunk 02's gate and chunk 02's reset-admin mode. No HTTP surface.

### 01e — Tests, CHANGELOG, FEATURES

---

## Test plan

- **Migration v35→v36** on a populated DB: existing rows untouched, `users` present, postcondition
  fires. Mutate the postcondition and watch it go red.
- **The length-guard regression**: a truncated / odd-length / non-hex stored hash returns `false`
  and does not throw. This test must fail against today's `lib/projects.js:77` — verify that it
  does before fixing.
- **Round trip**: hash, verify correct, reject wrong, reject empty, reject malformed.
- **`lib/projects.js` behavior preserved**: the project-delete guard's existing tests pass unchanged
  against the extracted module. It is the existing caller; this is a refactor for it, so its tests
  do not change (Tests Are Contracts).
- **User ops**: create, duplicate username rejected, lookup, password set + verify, disable, list.

---

## Status

- [ ] **01a — ADR 0016.** OQ1/OQ2/OQ3 + migration mechanism, each with reasoning.
- [ ] **01b — `lib/password.js`.** Extracted, length-guarded, `lib/projects.js` calls it.
- [ ] **01c — `users` table, v35→v36.** Conditional DDL, transaction, postcondition, no `role`.
- [ ] **01d — Store-layer user operations.** No HTTP surface.
- [ ] **01e — Tests, CHANGELOG (`### Added`), FEATURES.md.**
