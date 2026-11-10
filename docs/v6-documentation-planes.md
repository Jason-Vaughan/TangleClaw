# v6 documentation planes

Maintainer documentation (Plane 2 — see below). Implements issue #1151 (V6-13 / E1 & E3) as
scoped by Ruling A555-V60-T2-CHARTER-WAVE-DECOMPOSITION / A555-SUPPLEMENT-COSIGN for Car
V60-T2-W1-C. Issue #1151 itself is a vision document ("the exact module layout is not
binding"); this file documents the four concrete deliverables that ruling carved out of it,
implemented in `lib/v6/e1-doc-planes-context-compiler.js`.

## The four planes

Every path in this repository classifies into exactly one plane, deterministically, by path
alone (`classifyPlane`, never content- or mtime-based):

| Plane | Name | Audience | Example paths |
|---|---|---|---|
| 1 | **Product** | users, operators, contributors seeking orientation | `README.md`, `docs/product/**`, `docs/getting-started.md`, `docs/security.md` |
| 2 | **Maintainer** | human maintainers, architectural-work agents, reviewers | `CLAUDE.md`, `docs/adr/**`, `docs/architecture/**`, `docs/**` (catch-all) |
| 3 | **Operational memory** | the current/next agent session, Project Master | `.tangleclaw/memories/**`, `.tangleclaw/handoff/**`, `.prawduct/**`, `changelog.d/**`, `CHANGELOG.md`, `FEATURES.md` |
| 4 | **Historical archive** | searchable, but excluded from default context | any path containing an `archive/` segment |

A path matching none of the rules above defaults to **Plane 3 (operational memory)**, not to
a canonical plane — the product principle this model exists to serve is "generated
operational memory must not silently become canonical documentation," so the unmatched case
fails toward the *least* authoritative plane, never the most.

## The write-boundary guard

`checkWriteBoundary(path, { grant })` refuses an automated agent session write to a Plane 1 or
Plane 2 path unless `grant.path` names that exact path. Planes 3 and 4 are unprotected —
operational memory and the archive are exactly what agents are expected to write routinely.
This is a library-level check; it is not yet wired into any route or file-write call site (this
car ships the guard function, not its enforcement points — see "Not in this car" below).

## The context-assembly compiler

`compileContextBundle(paths, { tokenBudget, includeHistoricalArchive })` takes an
already-prioritized, caller-ordered list of candidate paths and returns:

- `included` — the paths that made it into the bundle, each with its plane and an estimated
  token count (`~4 bytes/token`, deterministic, never billed as exact).
- `excluded` — everything that didn't, with a reason (unreadable, over budget, or
  historical-archive excluded by default).
- `manifest` — a sha256 over exactly the included paths and their content, so two callers who
  get the same manifest hash can trust they loaded the same bundle.

Plane 4 is excluded by default, satisfying issue #1151's "large files must not be loaded
merely because they exist at a conventional path" for the archive specifically; pass
`includeHistoricalArchive: true` to override per call. Processing is first-come over the given
order: a path that would overflow the budget is skipped (not a hard stop), so a smaller
candidate later in the list can still fit.

## The Project SSOT Index

`syncSsotIndex(root)` scans every Plane 1/Plane 2 document under `root` and writes an
inventory — path, plane, sha256, byte count, sorted by path — to
`.tangleclaw/ssot-index.json` by default. `validateSsotIndex(root)` re-reads that inventory
and reports drift: an indexed document whose content no longer matches its recorded hash
(`ENTRY_STALE`), one that no longer exists (`ENTRY_GONE`), or a canonical document on disk the
index doesn't list at all (`ENTRY_UNINDEXED`).

**Known gap, not silently resolved:** this repo's own `.gitignore` fail-closes `.tangleclaw/*`
("internal working documents... never in this public repo"), and this car's file envelope does
not include `.gitignore`. `syncSsotIndex`/`validateSsotIndex` are fully implemented and tested
against an injectable root, but no `.tangleclaw/ssot-index.json` is committed by this PR —
escalated to PM/Architect to decide whether the path needs a `.gitignore` negation or is meant
to stay host-generated-only.

## Sprint/Wave Tracker helpers

Two small, pure, state-free helpers named in the same ruling:

- `checkCarDependencyAdmission(car, { completedCarIds })` — a car is admitted for dispatch only
  once every car it declares in `dependsOn` has completed.
- `evaluateWebhookStateAdvance(event, currentState)` — given an inbound webhook event type and
  the tracker's current state (`queued` → `dispatched` → `in-review` → `merged`, with `failed`
  reachable from `dispatched`/`in-review` and re-dispatchable), returns the next state, or holds
  if the event has no edge from the current state.

Both are pure functions over caller-supplied state: this car commits to zero
`lib/store/_schema.js` or `server.js` edits, so it persists nothing of its own — a caller
(a future BRIDGE-2b wiring car) owns storing the result.

## Not in this car

This car ships the four deliverables above as library functions, fully tested. It does **not**:

- Wire `checkWriteBoundary` into any real file-write call site.
- Wire `compileContextBundle` into any real launch/prime path.
- Commit a `.tangleclaw/ssot-index.json` (see the known gap above).
- Classify or restructure any existing documentation file — the plane rules describe where a
  path *would* land; no file in this repo is moved or reclassified by this PR.

That wiring, and the broader inventory/migration phases issue #1151 describes, are future
cars' scope.
