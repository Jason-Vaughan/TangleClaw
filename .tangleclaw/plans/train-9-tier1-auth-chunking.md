# Train 9 — Tier 1 Auth (ADR 0015): proposed chunking

**Status:** **APPROVED** by the operator 2026-09-11, with the five-chunk revision. Not a build plan; each chunk gets its own
build plan when it is picked up.
**Source:** `docs/adr/0015-tangleclaw-owns-authentication.md` (Accepted 2026-09-11, not built).
**Scope:** Tier 1 only — the front door, on any ingress mode. Tier 2 (resource defaults) is
explicitly out; ADR 0015 open question 5 says decide its shape before building it, and it never
gates a release.
**Author:** TangleClaw-Builder session, 2026-09-11, at the Coordinator's request.
**Revision 2 (same session):** chunk 00 folded into chunk 01 — see "Builder's recommendation".

---

## Builder's recommendation

**Build Tier 1 Auth now; do not finish Train 16 first.**

The reason is not sequencing tidiness. **A direct-mode install has no login at all today**
(`lib/store.js`, on `basicAuthUser`/`basicAuthHash`: "The gate lives at Caddy, so these only take
effect in caddy ingress mode").
That is a live gap in shipped software, and this project now has several outside installers. It
outranks everything on Train 16's remainder.

Train 16 is mostly *not* blocked by the cutover, which is the part worth checking rather than
assuming:

| Issue | Survives the cutover? | Why |
|---|---|---|
| #848 (unpinned HTTPS listener retrofit) | **Yes, untouched** | TLS + the h1 pin stay with Caddy — ADR 0015 "What Caddy keeps" |
| #846 (generator cannot emit an access log) | **Yes, untouched** | Same — logging stays with Caddy |
| #1361 (Dependabot zero-trust policy) | **Yes** | Unrelated to the gate |
| #1055 (stored `bindAllInterfaces` invisible in caddy mode) | **No** | The invisibility *is* the caddy-mode coupling being removed |
| #804 (derive "credential is mandatory" once) | **No** | ADR 0015 OQ4 orders it explicitly after this ADR |

**So the board re-cut is:**
- **Train 9** = Tier 1 Auth — #1416, #1417, #1418, #1419, #1420 (filed 2026-09-11) + #1055, #804, #803.
- **Train 16** = #848, #846, #1361 — a clean 3-issue, one-chunk train that can run before, after,
  or alongside Train 9. It is no longer a dependency in either direction.

---

## Two things to settle before any of this is real

### 1. The board and the directive disagree (Strict Sequence Guard)

`MASTER_ROADMAP.md` says:

- **Train 9: v6 Architecture** — `#1149, #1151, #966, #1084, #112, #111, #934, #869`
- Train 9 is under **"Blessed & Assigned (On Deck)"**, not "Currently Executing".
- **Train 16** (`#848, #846, #1055, #1056, #804, #870, #1062, #1361`) is also On Deck with
  **5 roster issues still open**: #848, #846, #1055, #804, #1361.
- **Train 15 Chunk 02 (#918)** is listed UNBLOCKED & READY and is still open.

The Coordinator's directive names Train 9 as **"Tier 1 Auth / ADR 0015"**. That is not the board's
Train 9. Of the board's eight, **#112, #111 and #869 are already CLOSED**, and only **#1149**
overlaps ADR 0015 — and ADR 0015 takes deliberately less of #1149 than #1149 describes ("the
identity half of that model and not the authorization half").

**Needs an operator override**, and the board needs re-cutting either way.

### 2. #1055 and #804 are on two trains at once

Both sit on Train 16's roster and both are squarely Tier 1 auth work:

- **#1055** (a stored `bindAllInterfaces: true` is invisible in caddy mode) is a symptom of the
  exact caddy-mode coupling ADR 0015 removes. Building it under Train 16 means building it
  against a gate that is about to move.
- **#804** (derive "a credential is mandatory here" once) — ADR 0015 open question 4 says
  explicitly that #804 **should follow this ADR, not precede it**, because the ADR changes what
  the predicate means.

Recommendation: move both onto Train 9 and shrink Train 16 to #848, #846, #1361.

---

## The risk that shapes the whole train

**This clone is the live install.** The launchd server serves `public/` off the working tree, and
the operator is almost never on this machine. A Tier 1 auth build is the highest-blast-radius
change this repo can make: a bug in the gate locks the operator out of their own dashboard,
from a phone, possibly from an unmerged branch.

Precedent: 2026-07-28 (#710), a `CACHE_NAME` bump behind the basic_auth gate put the operator in
a repeating credential prompt in Chrome.

Three constraints follow, and they are part of the plan, not caveats on it:

1. **Every chunk from 02 onward runs in a git worktree.** Primary checkout stays on `main`.
2. **The cutover chunk (04) needs a rollback that does not require physical access** — a documented
   env/flag kill-switch that re-opens the door, reachable from the tailnet, verified before the
   cutover merges. `scripts/reset-admin.js` is recovery for a *forgotten* credential; it is not
   recovery for *a broken gate*.
3. **A live-install VRF on elkaholic before the cutover merges**, not after.

---

## Proposed chunks

Five chunks. Each is ≤ 3 issues.

### Chunk 01 — Answer the blocking questions, and ship the user store dark

*Was two chunks (a no-code design spike, then the store). Merged on review: a session that produces
only an ADR addendum is ceremony, and the user store depends on none of the three questions — so
both land in one PR that changes nothing an operator can see.*

**The three ADR 0015 open questions that BLOCK code.** These are architecture decisions, not build
steps, and getting one wrong means rebuilding a later chunk:

- **OQ1 — cookie or bearer token?** Blocks chunks 02 *and* 03. The WebSocket upgrade path is the
  deciding constraint and it must be checked against `server.js#handleUpgrade`, not assumed.
- **OQ2 — does `X-Auth-User` survive?** `lib/auth-identity.js` is a whole module built on Caddy
  populating that header (`lib/caddy.js`). Blocks chunk 04.
- **OQ3 — what does `authEnabled` mean afterwards?** Under ADR 0009 it is a deliberate opt-out; it
  stops meaning "no Caddy gate" and starts meaning "no TangleClaw session". Blocks chunk 04 and the
  wizard copy.

Plus the **migration mechanism**: live installs carry a bcrypt `basicAuthHash` that scrypt cannot
verify, and per ADR 0009 it must not degrade to no gate meanwhile.

**Deliverable A:** an ADR 0015 addendum (or ADR 0016) answering OQ1–OQ3 and the migration.

**Deliverable B — the store, shipping dark:**

- `users` table, schema **v35 → v36**. No `users` table exists today (`lib/store.js`,
  `CURRENT_SCHEMA_VERSION = 35`).
- One owner for scrypt hash/verify. The primitives already exist at `lib/projects.js`
  guarding project deletion; extract to `lib/password.js` rather than writing a second copy —
  the same "derive it once" habit as #804 and #1399.

Nothing is gated. Nothing changes for the operator. Fully revertible.
**Issues:** #1416 (addendum), #1417 (store).

### Chunk 02 — Sessions and the HTTP gate

- `lib/auth-session.js`: token generation, expiry, **rotation on login** (session fixation),
  logout. Cookie flags per **ADR 0016** (`HttpOnly` always, `Secure` when https, `SameSite=Lax`).
- The gate at TangleClaw's own request entry, reusing the **existing** bypass definition —
  `isCaddyAuthBypassPath` / `AUTH_BYPASS_PATHS` (`lib/caddy.js`). ADR 0015: "one
  definition, moved, not duplicated." The fail-closed parity guard in `server.js#handleRequest` already
  depends on it and must keep working.
- Login page, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- CSRF on state-changing routes.

- **`scripts/reset-admin.js` gains its store-backed mode here.** Moved out of chunk 01 during that
  chunk's build: reset-admin is today the *Caddy* break-glass tool (bcrypt, Caddyfile patch,
  validate, reload), and a store-backed recovery path for a door not installed until this chunk
  could not be verified end to end. It lands with the gate it recovers, which is also what
  satisfies ADR 0009 rule 5 (recovery is a terminal tool outside the gate). `store.users.enable`
  exists for this caller — un-revoking an account the operator disabled is recovery, and a
  `disable` with no `enable` is a one-way door.
- **Password policy**: the set-password and login surfaces apply `caddy.validateAdminPassword`
  (min 12, denylist, no username match, no control chars) — ADR 0016. The store deliberately
  enforces only non-empty, so without this the new door is weaker than the one it replaces.
- **Async scrypt**: the login route uses `crypto.scrypt`, not `scryptSync`, or states why not.
  `scryptSync` blocks the single-threaded server for tens of milliseconds per attempt — ADR 0016.

Caddy's `basic_auth` is **still up** through this chunk — two gates in series, which is
inconvenient but never open. The cutover is chunk 04.
**Issues:** #1418.

### Chunk 03 — The WebSocket upgrade and the `/openclaw-direct/*` seam

The ADR names this "the single most likely place to get it wrong."

- Authenticate the upgrade **before** the socket is established, in `server.js#handleUpgrade`. It already carries the same-origin and served-Host guards (#864); the session
  check joins them rather than replacing them.
- `/terminal/*` proxies to a `--writable` ttyd — that socket is a shell.
- Decide `/openclaw-direct/*`: it carries its own gateway token and is currently exempt. ADR 0015
  flags two auth systems on adjacent paths as exactly the complexity ADR 0004 feared.

**Issues:** #1419.

### Chunk 04 — The cutover *(the dangerous one)*

- Caddy generator stops emitting `basic_auth`; `X-Auth-User` resolved per OQ2.
- `authEnabled` re-pointed per OQ3.
- **Migration**: bcrypt `basicAuthHash` → forced one-time password set under scrypt, with no
  window in which the door is open.
- `lib/bind-policy.js` simplifies: a wide bind is safe once TangleClaw is the gate, satisfying
  ADR 0009 without a reverse proxy in front.
- Closes **#1055** — the invisibility is the caddy-mode coupling this chunk removes.
- Kill-switch + elkaholic VRF per the risk section above, both landing *in* this chunk.

**Issues:** #1420 (cutover + migration), closes #1055.

### Chunk 05 — The follow-ons the ADR defers to last

- **#804** — derive the "credential is mandatory here" predicate once, now that the ADR has
  changed what it means (OQ4 orders it here explicitly).
- **#803** — the wizard's opt-out becomes buildable and honest: the wizard can now say what the
  opt-out actually opts out of.
- Docs: `docs/adr/0015` status → Built, FEATURES.md, CHANGELOG, and the migration note operators
  need.

**Issues:** #804, #803.

---

## Issue accounting

| | |
|---|---|
| Existing, reused | #1055 (closed by #1420), #804, #803 |
| Existing, epic (not a chunk) | #1149 — Tier 1 is its identity half only |
| Filed 2026-09-11 | #1416, #1417, #1418, #1419, #1420 |

All five new issues were filed 2026-09-11 after a duplicate search; the roster went to the
Coordinator over Medusa the same session.

## Explicitly NOT in this train

- **Tier 2** (resource defaults, engine/model filtering, usage limits, `project_members`).
  ADR 0015 OQ5: decide the shape first, default to the simpler one. It never gates a release.
- **Hosted clients / multi-tenancy.** ADR 0015 puts it out of scope and says it needs its own ADR.
- **Requirement 6** (per-user harness type) — the ADR marks it future scope, not first train.
