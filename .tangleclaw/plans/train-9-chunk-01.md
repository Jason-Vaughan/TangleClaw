# Train 9 — Chunk 01: the user store, and the questions that block the gate

**Issues:** #1416 (ADR addendum), #1417 (store)
**Branch:** `feat/1416-1417-tier1-auth-store`
**Worktree:** not required — this chunk touches neither `public/` nor `server.js`, which is what
the project's live-install rule scopes the worktree mandate to. Chunks 02-04 do touch them and
will run in one.
**Critic mode:** chunk
**Size:** medium
**Train plan:** `.tangleclaw/plans/train-9-tier1-auth-chunking.md`
**Baseline:** suite green at `b1b482cb` (0 fail, exit 0); evidence in `.prawduct/.test-evidence.json`.

---

## Confidence check

**Problem.** ADR 0015 is Accepted and unbuilt. A direct-mode TangleClaw install has no login at
all: `lib/store.js` says the credential only takes effect in caddy ingress mode, so
`basicAuthUser`/`basicAuthHash` in a direct-mode config enforce nothing. Before any of that can be
fixed, three of the ADR's open questions have to be decided, and there is nowhere to put a user.

**Success.** (1) An addendum answers OQ1/OQ2/OQ3 and the migration mechanism, with reasoning, so
chunks 02-04 build against decisions rather than guesses. (2) TangleClaw has a `users` table and a
single owner for scrypt hash/verify, exercised by tests, with **no change to any behaviour an
operator drives** — no route, no gate, no login.

**One exception, added during the build and called out because it is the only thing here that
touches a running install:** the database file is narrowed to 0600 on every boot (01f below). That
is a deliberate consequence of putting password hashes in it, not a dark-ship violation — but a
future session reading this plan must not conclude the chunk changed nothing on disk.

**Out of scope.** Sessions, cookies, login routes, CSRF, the WebSocket upgrade, removing Caddy's
gate, the bcrypt→scrypt migration *build* (decided here, built in chunk 04), and every tier-2
concept (resource defaults, `project_members`, engine filtering, usage limits).

**Requirements confidence: HIGH.** ADR 0015 is operator-ratified and states the tier-1 requirement
directly; this chunk builds only its store half, and the three questions that were genuinely open
are answered in 01a before any of it is used. The one inference carried: that the `salt:hash` format
already persisted for `config.deletePassword` is worth keeping rather than migrating — vetoable, and
its cost is recorded as a chunk-02 note (the format carries no algorithm tag).

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

`lib/projects.js#verifyPassword`:

```js
return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
```

`crypto.timingSafeEqual` **throws** on unequal buffer lengths. `derived` is always 64 bytes; `hash`
comes from the stored string, and `Buffer.from(x, 'hex')` silently truncates at the first invalid
pair — so a corrupt, truncated or hand-edited stored value makes `verifyPassword` **throw instead of
returning false**.

This repo already knows the hazard and solved it once: `lib/service-token.js#_safeEqual` guards length
first and documents why ("token length is not the secret"). The project-delete path it currently
guards turns this into a 500; on the login path it is a crash on a malformed row.

Fixed as part of the extraction, with a regression test. No "pre-existing" exception — and the fix
belongs here rather than later precisely because this is the chunk that makes these primitives
shared.

---

## Deliverables

### 01a — `docs/adr/0016-tier-1-auth-build-decisions.md` (#1416)

An addendum to ADR 0015, answering with reasoning:

- **OQ1 — cookie or bearer.** Must be checked against `server.js#handleUpgrade` (`handleUpgrade`), not
  assumed from the same-origin dashboard. Binds chunks 02 and 03.
- **OQ2 — `X-Auth-User` / AUTH-3.** `lib/auth-identity.js` exists to reason about a header
  `lib/caddy.js` populates. Say what it becomes.
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

Follows the v34→v35 pattern at `lib/store.js` exactly: conditional `ALTER`/`CREATE` because
`_createTables` runs before migrations, a `BEGIN IMMEDIATE` transaction, an explicit **postcondition**
read back from `sqlite_master` before `schema_version` advances, and `ROLLBACK` on failure.

Deliberately NOT included: `role`. ADR 0015 is explicit that the only genuine tier-1 distinction is
authenticated vs not, and that "Admin" is the operator's word for a tier-2 concept. A `role` column
added now would be a security-shaped field that nothing checks — the exact drift the ADR's tier
split exists to prevent. It arrives with tier 2 or not at all.

### 01d — Store-layer user operations (#1417)

Namespaced under `store.users`, so the verb names read against the noun. Every verb traces to a
named caller, because an unjustified verb on the auth surface costs a re-audit at every review:

| Verb | Who calls it |
|---|---|
| `create`, `setPassword`, `verify`, `getByName` | chunk 02's gate, and reset-admin's store mode |
| `disable` | ADR 0015's "revoke one person" row, verbatim |
| `enable` | reset-admin — un-revoking is recovery, and `disable` with no `enable` is a one-way door |
| `list` | the reset tool's account listing |

No HTTP surface. No `exists` helper: it invites check-then-act where `create`'s narrow
UNIQUE-constraint refusal is already the race-free answer.

### 01e — Tests, CHANGELOG, FEATURES

CHANGELOG lands under **`### Internal`**, not `### Added`. The chunk ships dark, so by CLAUDE.md's
user-visible-impact test nothing here is a feature an operator would notice next session — and the
subsection is what the version-bump step reads, so the choice is not cosmetic.

---

## Test plan

- **Migration v35→v36** on a populated DB: existing rows untouched, `users` present, postcondition
  fires. Mutate the postcondition and watch it go red.
- **The length-guard regression**: a truncated / odd-length / non-hex stored hash returns `false`
  and does not throw. This test must fail against today's `lib/projects.js#verifyPassword` — verify that it
  does before fixing.
- **Round trip**: hash, verify correct, reject wrong, reject empty, reject malformed.
- **`lib/projects.js` behavior preserved**: the project-delete guard's existing tests pass unchanged
  against the extracted module. It is the existing caller; this is a refactor for it, so its tests
  do not change (Tests Are Contracts).
- **User ops**: create, duplicate username rejected, lookup, password set + verify, disable, list.

---

## Status

- [x] **01a — ADR 0016.** OQ1/OQ2/OQ3 + migration mechanism, each with reasoning.
- [x] **01b — `lib/password.js`.** Extracted, length-guarded, `lib/projects.js` calls it.
- [x] **01c — `users` table, v35→v36.** Conditional DDL, transaction, postcondition, no `role`.
- [x] **01d — Store-layer user operations.** No HTTP surface.
- [x] **01e — Tests, CHANGELOG (`### Internal`), FEATURES.md.**
- [x] **01f — `tangleclaw.db` narrowed to 0600 on every boot.** Added mid-build as a Critic
      finding-fix: the file is created at the process umask and this chunk is what first put
      password hashes in it. `_tightenDbPermissions` owns both the repair and the report, because
      `_checkPermissions` runs before the database is opened. Two tests (fresh init under
      `umask 000`; re-narrowing an existing 0644 file).

---

## Critic record

`rev-20260912T060801Z-f613a0c1` — cumulative, 3 reviewers, over commit `f77e1fc9`.
**0 blocking, 12 warnings, 14 notes.** All 26 dispositioned in one pass
(`prawduct-hook render-dispositions --review rev-20260912T060801Z-f613a0c1`); 16 fixed in one
follow-up commit, 10 accepted with reasons.

The sharpest finding was one this session's own scrub half-missed. I checked that `store.users.verify`
returns `null` identically on all three failures and wrote that down as an anti-oracle guarantee in
two shipped places. The Critic found the other half: the no-row and disabled paths returned
**without paying scrypt**, so the three were distinguishable by response time even though the value
matched — and chunk 02's author would have built `POST /api/auth/login` on the JSDoc's promise.
The return value was never the whole oracle. Fixed by comparing against `ABSENT_USER_HASH` on both
early paths, with a timing test that reds when the comparison is removed.

Second-sharpest was structural rather than technical: recording the `reset-admin` scope correction
in THIS file was the right instinct and the wrong location, because this file archives when the
chunk ships. The durable artifacts — the train plan's chunk 02 bullets, and ADR 0016 — now carry it,
along with the password-policy owner and the async-scrypt decision, none of which were in #1418 when
it was filed.

### Rounds 2-4

`rev-20260912T062414Z-8607011d` (verify-resolutions) — 0 blocking, 0 findings. It **declined to mark
R-7 resolved**, correctly: R-7 was scoped as a CLASS ("every ADR status line naming another ADR's
state") and I had closed it only at the site it happened to list, leaving `docs/adr/0004` calling
ADR 0015 "proposed" four days after it was accepted. Six observations rode out of it, including two
defects the fix commit itself introduced — an orphaned JSDoc and a warning that fired on a condition
its own caller repaired.

`rev-20260912T063143Z-fc03d99e` (cumulative) — 0 blocking, 11 warnings, 14 notes, all 25
dispositioned. The one that mattered: **the timing guard I wrote for the oracle fix was itself the
flaky shape this repo has a recorded rule against**, comparing elapsed medians and so scoring the CI
runner's scheduler. Replaced with a spy that COUNTS `verifyPassword` calls. Also caught that the
0600 chmod — added mid-build as a finding-fix — appeared in no record at all while this plan still
claimed the chunk changed nothing on disk.

`rev-20260912T064618Z-9433e18f` (verify-resolutions) — **0 blocking, 0 warnings, 0 notes.** Verified
each claimed fix at its site rather than from the commit message, and confirmed neither test change
was a weakening. Coverage closed.

### What the round count actually says

Four rounds, ~35 minutes. Round 1 found a timing channel I could not have found by re-reading my own
code. **Every round after that was spent on defects introduced BY a finding-fix** — a flaky guard, an
orphaned JSDoc, a self-repairing warning, records that still described the pre-fix shape, and a
citation to a constant the fix had deleted. That is one recorded learning
(`feedback_finding_fix_is_new_code`) hit four times in a single chunk.

The habit that would collapse all of them, and the thing to carry into chunk 02: **after writing a
finding-fix, re-read the whole region it lands in and ask which records claimed the old shape.** The
fix is not done when the code is right.

### Accepted, not fixed — so chunk 02 is not misled

The lazy derivation has a one-shot asymmetry the JSDoc does not mention: the first
unknown-or-disabled `verify` in a process pays two scrypts (derive + compare) against the
wrong-password path's one. One sample per process, in the safe direction (unknown is *slower*),
confounded by warm-up, and not usable as an oracle — but the JSDoc claims equal cost
unconditionally and the counting test is blind to it by construction. Left as-is because fixing a
comment would have bought a fifth review round; recorded here instead.
